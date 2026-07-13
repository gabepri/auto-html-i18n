import type { ObserverConfig } from './types';
import { isIgnoredElement, isInsideIgnored, serializeAggregate, type IgnorePredicateConfig } from './ignore';

export class Observer {
  private config: ObserverConfig;
  private mutationObserver: MutationObserver | null = null;
  private allowedInlineTagsSet: Set<string>;
  private processedParents = new WeakSet<Element>();
  private ignorePredicate: IgnorePredicateConfig;
  private ignoreMemo: Map<Element, boolean> | null = null;

  constructor(config: ObserverConfig) {
    this.config = config;
    this.allowedInlineTagsSet = new Set(config.allowedInlineTags);
    this.ignorePredicate = {
      ignoreAttribute: config.ignoreAttribute,
      ignoreSelectors: config.ignoreSelectors,
    };
  }

  /**
   * Serialized inner HTML of an aggregation target, with any ignored descendant
   * subtree bracketed so the Masker masks it as one opaque variable (keeping its
   * user-data text out of the translatable unit).
   */
  private aggregatedContent(target: Element): string {
    return serializeAggregate(target, this.ignorePredicate);
  }

  start(): void {
    this.processSubtree(this.config.rootElement);

    this.mutationObserver = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    this.mutationObserver.observe(this.config.rootElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: this.config.translatableAttributes,
    });
  }

  stop(): void {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
  }

  processSubtree(root: Node): void {
    this.processedParents = new WeakSet<Element>();

    // The walk below only checks each node against the ignore predicate itself, which
    // relies on the walk root's own ancestry being clean. That holds for start()'s
    // root, but processSubtree is callable with any node — so verify it once here.
    if (this.isInsideIgnored(root)) {
      return;
    }

    this.walk(root);
  }

  reprocessAll(): void {
    const elements = this.config.rootElement.querySelectorAll(
      `[${this.config.originalAttribute}]`
    );
    for (const element of elements) {
      const originalText = element.getAttribute(this.config.originalAttribute);
      if (originalText) {
        this.config.onTextFound(element, originalText);
      }
    }
  }

  private handleMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (this.isInsideIgnored(node)) continue;

          if (node.nodeType === Node.ELEMENT_NODE) {
            this.processedParents = new WeakSet<Element>();
            // isInsideIgnored above already cleared this node and its ancestors, which
            // is the precondition walk()'s self-only filter relies on.
            this.walk(node as Element);
          } else if (node.nodeType === Node.TEXT_NODE) {
            this.processTextNode(node as Text);
          }
        }
      } else if (mutation.type === 'characterData') {
        const node = mutation.target;
        if (!this.isInsideIgnored(node)) {
          this.processTextNode(node as Text);
        }
      } else if (mutation.type === 'attributes' && mutation.target instanceof Element) {
        const element = mutation.target;
        if (!this.isInsideIgnored(element)) {
          const attrName = mutation.attributeName;
          if (attrName && this.config.translatableAttributes.includes(attrName)) {
            const value = element.getAttribute(attrName);
            if (value && value.trim()) {
              this.config.onAttributeFound(element, attrName, value);
            }
          }
        }
      }
    }
  }

  /**
   * Collects everything translatable under `root`, then fires the callbacks.
   *
   * Collection completes before any callback runs, so a synchronous translation's DOM
   * mutations can't disrupt the TreeWalker mid-walk.
   *
   * The filter tests each *element* against the ignore predicate alone, not its whole
   * ancestry: FILTER_REJECT prunes an ignored element's entire subtree, so any node the
   * walker offers us is already known to have no ignored ancestor inside the walk (and
   * the caller guarantees the root's own ancestry is clean). Walking up from every node
   * instead would re-run every ignoreSelector once per ancestor per node — work that
   * grows with tree depth and dominates the walk on a deep page. Text nodes need no
   * check at all: they can't be ignore boundaries, and their parent was accepted.
   */
  private walk(root: Node): void {
    const textItems: Array<{ element: Element; text: string; textNode?: Text }> = [];
    const attrItems: Array<{ element: Element; attr: string; value: string }> = [];

    if (root instanceof Element) {
      this.collectElementAttrs(root, attrItems);
    }

    // Memoized for the collection phase only: a TreeWalker may consult its filter more
    // than once for the same node, and each miss costs a matches() per ignoreSelector.
    // Torn down before the callbacks run, since those mutate the DOM.
    this.ignoreMemo = new Map<Element, boolean>();

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node: Node) =>
          node.nodeType === Node.ELEMENT_NODE && this.isIgnored(node as Element)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      }
    );

    let node: Node | null = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        this.collectElementAttrs(node as Element, attrItems);
      } else if (node.nodeType === Node.TEXT_NODE) {
        this.collectTextNode(node as Text, textItems);
      }
      node = walker.nextNode();
    }

    this.ignoreMemo = null;

    for (const item of attrItems) {
      this.config.onAttributeFound(item.element, item.attr, item.value);
    }
    for (const item of textItems) {
      this.config.onTextFound(item.element, item.text, item.textNode);
    }
  }

  /** Is this element itself an ignore boundary? Memoized while a walk is collecting. */
  private isIgnored(element: Element): boolean {
    const memo = this.ignoreMemo;
    if (!memo) return isIgnoredElement(element, this.ignorePredicate);

    let hit = memo.get(element);
    if (hit === undefined) {
      hit = isIgnoredElement(element, this.ignorePredicate);
      memo.set(element, hit);
    }
    return hit;
  }

  private processTextNode(textNode: Text): void {
    const text = textNode.textContent;
    if (!text || !text.trim()) return;

    const parent = textNode.parentElement;
    if (!parent) return;

    const aggregationTarget = this.findAggregationTarget(parent);

    if (aggregationTarget) {
      if (!this.processedParents.has(aggregationTarget)) {
        this.processedParents.add(aggregationTarget);
        const innerHTML = this.aggregatedContent(aggregationTarget);
        if (innerHTML.trim()) {
          this.config.onTextFound(aggregationTarget, innerHTML);
        }
      }
      return;
    }

    this.config.onTextFound(parent, text, textNode);
  }

  private collectElementAttrs(
    element: Element,
    out: Array<{ element: Element; attr: string; value: string }>
  ): void {
    for (const attr of this.config.translatableAttributes) {
      const value = element.getAttribute(attr);
      if (value && value.trim()) {
        out.push({ element, attr, value });
      }
    }
  }

  private collectTextNode(
    textNode: Text,
    out: Array<{ element: Element; text: string; textNode?: Text }>
  ): void {
    const text = textNode.textContent;
    if (!text || !text.trim()) return;

    const parent = textNode.parentElement;
    if (!parent) return;

    const aggregationTarget = this.findAggregationTarget(parent);

    if (aggregationTarget) {
      if (!this.processedParents.has(aggregationTarget)) {
        this.processedParents.add(aggregationTarget);
        const innerHTML = this.aggregatedContent(aggregationTarget);
        if (innerHTML.trim()) {
          out.push({ element: aggregationTarget, text: innerHTML });
        }
      }
      return;
    }

    out.push({ element: parent, text, textNode });
  }

  /**
   * Walk up from an element to find the OUTERMOST ancestor that aggregates as a
   * formatted sentence. When aggregation targets nest (an element and one of its
   * descendants both qualify), the descendant's content already rides inside the
   * ancestor's unit as inline markers, so only the outermost should be reported —
   * otherwise the inner content is collected twice.
   */
  private findAggregationTarget(element: Element): Element | null {
    let current: Element | null = element;
    let target: Element | null = null;
    while (current && current !== this.config.rootElement) {
      if (this.hasInlineChildElements(current)) {
        // Qualifies, but a further ancestor may aggregate this one as inline
        // content; keep climbing and remember the outermost qualifying element.
        target = current;
        current = current.parentElement;
        continue;
      }
      // If current element is itself an inline tag, check its parent
      if (this.allowedInlineTagsSet.has(current.tagName.toLowerCase())) {
        current = current.parentElement;
        continue;
      }
      break;
    }
    return target;
  }

  private hasInlineChildElements(element: Element): boolean {
    const children = element.children;
    if (children.length === 0) return false;
    // Every child — and its entire subtree — must be inline-allowed. A non-inline
    // element anywhere below (e.g. an <input> or <svg> nested in an otherwise
    // inline <span>) means this isn't a formatted run of text; aggregating it
    // would drag non-translatable markup into the cache key.
    for (const child of children) {
      if (!this.isFullyInline(child)) return false;
    }
    // Aggregate only a genuine formatted sentence — one with its own direct,
    // interleaved text. A container whose children are all inline elements but
    // which has no direct text of its own (a nav menu, link list, or button
    // group) is structural, not a sentence: aggregating it would collapse the
    // whole subtree into one cache key. Translate such children individually so
    // each keeps its own key and its live DOM node.
    // (This subsumes the single-inline-child wrapper case.)
    if (!this.hasDirectTextContent(element)) {
      return false;
    }
    return true;
  }

  /** True when `element` and all of its descendant elements are allowed inline tags. */
  private isFullyInline(element: Element): boolean {
    if (!this.allowedInlineTagsSet.has(element.tagName.toLowerCase())) return false;
    for (const child of element.children) {
      if (!this.isFullyInline(child)) return false;
    }
    return true;
  }

  private hasDirectTextContent(element: Element): boolean {
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
        return true;
      }
    }
    return false;
  }

  private isInsideIgnored(node: Node): boolean {
    return isInsideIgnored(node, this.config);
  }
}
