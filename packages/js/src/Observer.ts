import type { ObserverConfig } from './types';

export class Observer {
  private config: ObserverConfig;
  private mutationObserver: MutationObserver | null = null;
  private allowedInlineTagsSet: Set<string>;
  private processedParents = new WeakSet<Element>();

  constructor(config: ObserverConfig) {
    this.config = config;
    this.allowedInlineTagsSet = new Set(config.allowedInlineTags);
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

    // Collect all items first, then fire callbacks.
    // This prevents DOM mutations (from sync translations) from disrupting the TreeWalker.
    const textItems: Array<{ element: Element; text: string }> = [];
    const attrItems: Array<{ element: Element; attr: string; value: string }> = [];

    if (root instanceof Element) {
      this.collectElementAttrs(root, attrItems);
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node: Node) => {
          if (this.isInsideIgnored(node)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
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

    // Now fire all callbacks (DOM mutations from sync translations won't disrupt the walk)
    for (const item of attrItems) {
      this.config.onAttributeFound(item.element, item.attr, item.value);
    }
    for (const item of textItems) {
      this.config.onTextFound(item.element, item.text);
    }
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
            this.processSubtreeForMutation(node as Element);
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

  private processSubtreeForMutation(element: Element): void {
    // Collect all items first, then fire callbacks.
    // This prevents DOM mutations (from sync translations) from disrupting the TreeWalker.
    const textItems: Array<{ element: Element; text: string }> = [];
    const attrItems: Array<{ element: Element; attr: string; value: string }> = [];

    this.collectElementAttrs(element, attrItems);

    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node: Node) => {
          if (this.isInsideIgnored(node)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
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

    // Now fire all callbacks (DOM mutations from sync translations won't disrupt the walk)
    for (const item of attrItems) {
      this.config.onAttributeFound(item.element, item.attr, item.value);
    }
    for (const item of textItems) {
      this.config.onTextFound(item.element, item.text);
    }
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
        const innerHTML = aggregationTarget.innerHTML;
        if (innerHTML.trim()) {
          this.config.onTextFound(aggregationTarget, innerHTML);
        }
      }
      return;
    }

    this.config.onTextFound(parent, text);
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
    out: Array<{ element: Element; text: string }>
  ): void {
    const text = textNode.textContent;
    if (!text || !text.trim()) return;

    const parent = textNode.parentElement;
    if (!parent) return;

    const aggregationTarget = this.findAggregationTarget(parent);

    if (aggregationTarget) {
      if (!this.processedParents.has(aggregationTarget)) {
        this.processedParents.add(aggregationTarget);
        const innerHTML = aggregationTarget.innerHTML;
        if (innerHTML.trim()) {
          out.push({ element: aggregationTarget, text: innerHTML });
        }
      }
      return;
    }

    out.push({ element: parent, text });
  }

  /** Walk up from an element to find the nearest ancestor that has inline child elements */
  private findAggregationTarget(element: Element): Element | null {
    let current: Element | null = element;
    while (current && current !== this.config.rootElement) {
      if (this.hasInlineChildElements(current)) {
        return current;
      }
      // If current element is itself an inline tag, check its parent
      if (this.allowedInlineTagsSet.has(current.tagName.toLowerCase())) {
        current = current.parentElement;
        continue;
      }
      break;
    }
    return null;
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
    // whole subtree into one cache key and one innerHTML unit whose apply
    // recreates the child nodes (dropping their framework listeners). Translate
    // such children individually so each keeps its own key and its live DOM node.
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
    let current: Node | null = node;
    while (current && current !== this.config.rootElement) {
      if (current instanceof Element) {
        if (current.hasAttribute(this.config.ignoreAttribute)) {
          return true;
        }
        for (const selector of this.config.ignoreSelectors) {
          if (current.matches(selector)) {
            return true;
          }
        }
      }
      current = current.parentNode;
    }
    return false;
  }
}
