import type { CasePattern, TranslationEntry, TranslationItem, TranslationItemDebug, OnMissingTranslationCallback, MaskResult, VariableInfo } from './types';
import { Store } from './Store';
import { Queue } from './Queue';
import { Masker } from './Masker';

// ICU plural/select constructs pick one branch at evaluation time, so the masked
// markers (which appear in every branch) won't line up with the evaluated output.
// When we detect one, skip the node-preserving morph and do a plain replace.
const ICU_PATTERN = /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\b/;

export interface TranslatorConfig {
  locale: string;
  originalAttribute: string;
  pendingAttribute: string;
  keyAttribute: string;
  scopeAttribute: string;
  translatableAttributes: string[];
  onMissingTranslation: OnMissingTranslationCallback;
  debug: boolean;
}

interface PendingNode {
  element: Element;
  variables: VariableInfo[];
  tagAttributes: Map<string, Record<string, string>>;
  casePattern: CasePattern;
  leadingWhitespace: string;
  trailingWhitespace: string;
  originalText: string;
  /** Displayed content at tracking time — if it changed since, the node is stale. */
  snapshot: string;
  isAttribute?: boolean;
  attrName?: string;
  isHtml: boolean;
  scope?: string;
}

export class Translator {
  private store: Store;
  private queue: Queue;
  private masker: Masker;
  private config: TranslatorConfig;
  private pendingNodes = new Map<string, Set<PendingNode>>();
  // Last output we wrote per element/attribute. Lets us tell our own mutation
  // echoes apart from external rewrites (frameworks patching translated nodes),
  // and protects newer content from stale applies and reverts.
  private lastApplied = new WeakMap<Element, string>();
  private lastAppliedAttrs = new WeakMap<Element, Map<string, string>>();
  // Marker identity (e.g. "a0", "span1") recorded per inline child element we've
  // placed in an aggregated unit, so a later re-translate can reuse the same live
  // nodes even when a translation reordered them. See morphInto/buildMarkerToNode.
  private nodeMarkers = new WeakMap<Element, string>();

  constructor(
    store: Store,
    queue: Queue,
    masker: Masker,
    config: TranslatorConfig
  ) {
    this.store = store;
    this.queue = queue;
    this.masker = masker;
    this.config = config;
  }

  processText(element: Element, originalText: string): void {
    const last = this.lastApplied.get(element);
    if (last !== undefined && originalText === last) {
      return; // echo of our own write
    }
    if (element.hasAttribute(this.config.originalAttribute)) {
      if (last === undefined) {
        return; // translated content we didn't write (e.g. server-rendered)
      }
      // Externally rewritten after we translated it — the marker is stale;
      // treat the incoming text as fresh source
      element.removeAttribute(this.config.originalAttribute);
      this.lastApplied.delete(element);
    }

    const keyOverride = element.getAttribute(this.config.keyAttribute);
    const isHtml = /<[^>]+>/.test(originalText);
    const maskResult = this.masker.mask(originalText);

    // Skip if masked text has no translatable content (only variables, tags, whitespace, punctuation)
    if (!keyOverride && !hasTranslatableContent(maskResult.masked)) {
      return;
    }

    const cacheKey = keyOverride ?? maskResult.masked;
    const scope = this.resolveScope(element);

    const entry = this.store.get(this.config.locale, cacheKey);

    if (entry && entry.status === 'resolved' && entry.value !== null) {
      const resolved = resolveEntry(entry.value, scope);
      if (resolved) {
        this.applyTranslation(element, resolved, maskResult, originalText, isHtml, maskResult.casePattern);
      }
      return;
    }

    // Build item before mutating the element so debug info captures original state
    const item = this.buildItem(cacheKey, originalText, maskResult.variables, element, 'text', scope);

    element.setAttribute(this.config.pendingAttribute, '');

    if (entry && (entry.status === 'pending' || entry.status === 'reported')) {
      this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml, scope);
      return;
    }

    this.store.markPending(this.config.locale, cacheKey);
    this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml, scope);
    this.queue.enqueue(item);
  }

  processAttribute(element: Element, attr: string, originalValue: string): void {
    const originalAttrName = `${this.config.originalAttribute}-${attr}`;
    const lastAttrs = this.lastAppliedAttrs.get(element);
    const last = lastAttrs?.get(attr);

    if (last !== undefined && originalValue === last) {
      return; // echo of our own write
    }
    if (element.hasAttribute(originalAttrName)) {
      if (last === undefined) {
        return; // translated attribute we didn't write (e.g. server-rendered)
      }
      // Externally rewritten after we translated it — the marker is stale
      element.removeAttribute(originalAttrName);
      lastAttrs?.delete(attr);
    }

    const maskResult = this.masker.mask(originalValue);

    if (!hasTranslatableContent(maskResult.masked)) {
      return;
    }

    const cacheKey = maskResult.masked;
    const scope = this.resolveScope(element);

    const entry = this.store.get(this.config.locale, cacheKey);

    if (entry && entry.status === 'resolved' && entry.value !== null) {
      const resolved = resolveEntry(entry.value, scope);
      if (resolved) {
        this.applyAttributeTranslation(element, attr, resolved, maskResult, originalValue);
        element.setAttribute(originalAttrName, originalValue);
      }
      return;
    }

    if (!entry) {
      this.store.markPending(this.config.locale, cacheKey);
      this.queue.enqueue(
        this.buildItem(cacheKey, originalValue, maskResult.variables, element, `attribute:${attr}`, scope)
      );
    }

    const pendingNode: PendingNode = {
      element,
      variables: maskResult.variables,
      tagAttributes: maskResult.tagAttributes,
      casePattern: maskResult.casePattern,
      leadingWhitespace: maskResult.leadingWhitespace,
      trailingWhitespace: maskResult.trailingWhitespace,
      originalText: originalValue,
      snapshot: originalValue,
      isAttribute: true,
      attrName: attr,
      isHtml: false,
      scope,
    };
    this.addToPendingSet(cacheKey, pendingNode);
  }

  applyPending(cacheKey: string): void {
    const pending = this.pendingNodes.get(cacheKey);
    if (!pending) return;

    const entry = this.store.get(this.config.locale, cacheKey);
    if (!entry || entry.status !== 'resolved' || entry.value === null) return;

    for (const node of pending) {
      if (!node.element.isConnected) continue;

      const resolved = resolveEntry(entry.value, node.scope);
      if (!resolved) continue;

      if (node.isAttribute && node.attrName) {
        // Skip if the attribute changed since it was tracked — the newer
        // value has its own translation cycle
        if (node.element.getAttribute(node.attrName) !== node.snapshot) continue;

        this.applyAttributeTranslation(node.element, node.attrName, resolved, node, node.originalText);
        const originalAttrName = `${this.config.originalAttribute}-${node.attrName}`;
        node.element.setAttribute(originalAttrName, node.originalText);
      } else {
        // Skip if the content changed since it was tracked — the newer
        // content has its own translation cycle
        const current = node.isHtml ? node.element.innerHTML : node.element.textContent;
        if (current !== node.snapshot) continue;

        this.applyTranslation(node.element, resolved, {
          masked: cacheKey,
          variables: node.variables,
          tagAttributes: node.tagAttributes,
          casePattern: node.casePattern,
          leadingWhitespace: node.leadingWhitespace,
          trailingWhitespace: node.trailingWhitespace,
        }, node.originalText, node.isHtml, node.casePattern);
      }
    }

    this.pendingNodes.delete(cacheKey);
  }

  retranslateAll(): void {
    const elements = document.querySelectorAll(
      `[${this.config.originalAttribute}]`
    );
    for (const element of elements) {
      const originalText = element.getAttribute(this.config.originalAttribute);
      if (!originalText) continue;

      const keyOverride = element.getAttribute(this.config.keyAttribute);
      const isHtml = /<[^>]+>/.test(originalText);
      const maskResult = this.masker.mask(originalText);

      if (!keyOverride && !hasTranslatableContent(maskResult.masked)) {
        continue;
      }

      const cacheKey = keyOverride ?? maskResult.masked;
      const scope = this.resolveScope(element);

      // Skip elements whose content changed since we last wrote them — the
      // marker is stale and re-applying would clobber the newer content
      const lastKnown = this.lastApplied.get(element);
      const current = isHtml ? element.innerHTML : element.textContent;
      if (lastKnown !== undefined && current !== lastKnown) {
        continue;
      }

      const entry = this.store.get(this.config.locale, cacheKey);
      if (entry && entry.status === 'resolved' && entry.value !== null) {
        const resolved = resolveEntry(entry.value, scope);
        if (resolved) {
          this.applyTranslation(element, resolved, maskResult, originalText, isHtml, maskResult.casePattern);
        }
      } else if (!entry) {
        const item = this.buildItem(cacheKey, originalText, maskResult.variables, element, 'text', scope);
        element.setAttribute(this.config.pendingAttribute, '');
        this.store.markPending(this.config.locale, cacheKey);
        this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml, scope);
        this.queue.enqueue(item);
      }
    }

    // Re-translate attributes with original-tracking data
    for (const attr of this.config.translatableAttributes) {
      const originalAttrName = `${this.config.originalAttribute}-${attr}`;
      const attrElements = document.querySelectorAll(`[${originalAttrName}]`);

      for (const element of attrElements) {
        const originalValue = element.getAttribute(originalAttrName);
        if (!originalValue) continue;

        const maskResult = this.masker.mask(originalValue);
        if (!hasTranslatableContent(maskResult.masked)) continue;

        // Skip attributes whose value changed since we last wrote them
        const lastKnown = this.lastAppliedAttrs.get(element)?.get(attr);
        if (lastKnown !== undefined && element.getAttribute(attr) !== lastKnown) {
          continue;
        }

        const cacheKey = maskResult.masked;
        const scope = this.resolveScope(element);
        const entry = this.store.get(this.config.locale, cacheKey);

        if (entry && entry.status === 'resolved' && entry.value !== null) {
          const resolved = resolveEntry(entry.value, scope);
          if (resolved) {
            this.applyAttributeTranslation(element, attr, resolved, maskResult, originalValue);
          }
        } else if (!entry) {
          const item = this.buildItem(cacheKey, originalValue, maskResult.variables, element, `attribute:${attr}`, scope);
          this.store.markPending(this.config.locale, cacheKey);
          const pendingNode: PendingNode = {
            element,
            variables: maskResult.variables,
            tagAttributes: maskResult.tagAttributes,
            casePattern: maskResult.casePattern,
            leadingWhitespace: maskResult.leadingWhitespace,
            trailingWhitespace: maskResult.trailingWhitespace,
            originalText: originalValue,
            // Currently displaying the previous locale's output, not the original
            snapshot: element.getAttribute(attr) ?? '',
            isAttribute: true,
            attrName: attr,
            isHtml: false,
            scope,
          };
          this.addToPendingSet(cacheKey, pendingNode);
          this.queue.enqueue(item);
        }
      }
    }
  }

  revertAll(): void {
    // Revert text nodes
    const elements = document.querySelectorAll(
      `[${this.config.originalAttribute}]`
    );
    for (const element of elements) {
      const originalText = element.getAttribute(this.config.originalAttribute);
      if (originalText) {
        const isHtml = /<[^>]+>/.test(originalText);
        // Only restore if the content is still what we wrote — otherwise the
        // element was rewritten since and the newer content wins
        const lastKnown = this.lastApplied.get(element);
        const current = isHtml ? element.innerHTML : element.textContent;
        if (lastKnown === undefined || current === lastKnown) {
          if (isHtml) {
            element.innerHTML = originalText;
          } else {
            element.textContent = originalText;
          }
        }
      }
      element.removeAttribute(this.config.originalAttribute);
      element.removeAttribute(this.config.pendingAttribute);
      this.lastApplied.delete(element);
    }

    // Revert attributes
    for (const attr of this.config.translatableAttributes) {
      const originalAttrName = `${this.config.originalAttribute}-${attr}`;
      const attrElements = document.querySelectorAll(`[${originalAttrName}]`);
      for (const element of attrElements) {
        const originalValue = element.getAttribute(originalAttrName);
        if (originalValue) {
          const lastKnown = this.lastAppliedAttrs.get(element)?.get(attr);
          if (lastKnown === undefined || element.getAttribute(attr) === lastKnown) {
            element.setAttribute(attr, originalValue);
          }
          this.lastAppliedAttrs.get(element)?.delete(attr);
        }
        element.removeAttribute(originalAttrName);
      }
    }

    // Remove pending attributes from any remaining pending-only elements
    const pendingElements = document.querySelectorAll(
      `[${this.config.pendingAttribute}]`
    );
    for (const element of pendingElements) {
      element.removeAttribute(this.config.pendingAttribute);
    }

    this.pendingNodes.clear();
  }

  clearPending(): void {
    this.pendingNodes.clear();
  }

  /**
   * Flush-time re-validation guard. The collection-time ignore check runs once,
   * when a node is first seen; portalled/late-mounted content can settle under an
   * ignore ancestor (or unmount entirely) in the debounce window before the batch
   * is reported. For each item, look at the DOM node(s) we still track for it and
   * keep the item only if at least one is live and not ignored. Drop items whose
   * every tracked node is ignored or detached, forgetting their pending state so
   * the same string can be collected again if it legitimately reappears later.
   *
   * `isIgnored` is injected (the shared ignore predicate) so the Translator stays
   * free of ignore/root config.
   */
  filterReportable(
    items: TranslationItem[],
    isIgnored: (node: Node) => boolean
  ): TranslationItem[] {
    const reportable: TranslationItem[] = [];
    for (const item of items) {
      const nodes = this.pendingNodes.get(item.masked);
      // No tracked nodes (already applied/cleared, or never tracked): nothing to
      // re-validate against — preserve the pre-guard behavior and report it.
      if (!nodes || nodes.size === 0) {
        reportable.push(item);
        continue;
      }

      let hasLive = false;
      for (const node of nodes) {
        if (node.element.isConnected && !isIgnored(node.element)) {
          hasLive = true;
          break;
        }
      }

      if (hasLive) {
        reportable.push(item);
      } else {
        this.pendingNodes.delete(item.masked);
        this.store.resetIfPending(this.config.locale, item.masked);
      }
    }
    return reportable;
  }

  setLocale(locale: string): void {
    this.config.locale = locale;
  }

  get locale(): string {
    return this.config.locale;
  }

  private resolveScope(element: Element): string | undefined {
    let current: Element | null = element;
    while (current) {
      const scope = current.getAttribute(this.config.scopeAttribute);
      if (scope) return scope;
      current = current.parentElement;
    }
    return undefined;
  }

  private applyTranslation(
    element: Element,
    value: string,
    maskResult: MaskResult,
    originalText: string,
    isHtml: boolean,
    casePattern: CasePattern
  ): void {
    const unmasked = this.masker.unmask(value, maskResult.variables, maskResult.tagAttributes, this.config.locale, originalText);
    const output = maskResult.leadingWhitespace + this.masker.applyCasePattern(unmasked, casePattern) + maskResult.trailingWhitespace;

    if (isHtml) {
      this.morphInto(element, output, value);
      // Record the browser's serialization, which is what mutation callbacks
      // will echo back
      this.lastApplied.set(element, element.innerHTML);
    } else {
      element.textContent = output;
      this.lastApplied.set(element, output);
    }

    element.setAttribute(this.config.originalAttribute, originalText);
    element.removeAttribute(this.config.pendingAttribute);
  }

  /**
   * Write translated HTML into `element` while preserving the original child
   * element instances (and their event listeners / framework bindings) wherever
   * possible. Each inline tag in the source was masked to a `<tagN>` marker; we
   * reuse the live node that marker points to and graft the translated content
   * into it, instead of recreating everything via `innerHTML =`. Falls back to a
   * plain innerHTML assignment whenever the markers can't be matched 1:1 (ICU
   * branch selection, or tags the translation added/dropped), so the written
   * output is always correct — node reuse is a best-effort enhancement over it.
   */
  private morphInto(element: Element, output: string, maskedValue: string): void {
    if (ICU_PATTERN.test(maskedValue)) {
      element.innerHTML = output;
      return;
    }

    // Opening markers in document order, e.g. ["a0", "span1"]. Closing markers
    // (</a0>) and variable masks ({{0}}) don't match this and are ignored.
    const markers: string[] = [];
    const markerRe = /<(\w+?)(\d+)>/g;
    let match: RegExpExecArray | null;
    while ((match = markerRe.exec(maskedValue)) !== null) {
      markers.push(`${match[1]}${match[2]}`);
    }

    const template = document.createElement('template');
    template.innerHTML = output;
    const fragment = template.content;
    const outElements = fragment.querySelectorAll('*');

    // unmask preserves tree shape, so the k-th output element lines up with the
    // k-th opening marker. If they don't, we can't map reliably — bail to a plain
    // replace (correct output, just without node reuse).
    if (outElements.length !== markers.length) {
      element.innerHTML = output;
      return;
    }

    const markerToNode = this.buildMarkerToNode(element);

    for (let k = 0; k < outElements.length; k++) {
      const outElement = outElements[k]!;
      const marker = markers[k]!;
      const original = markerToNode.get(marker);

      if (original && original.tagName === outElement.tagName) {
        // Reuse the live node: replace its content with the translated children
        // and strip inline event-handler attributes, matching the sanitization
        // the string path applies through unmask.
        while (original.firstChild) original.removeChild(original.firstChild);
        while (outElement.firstChild) original.appendChild(outElement.firstChild);
        for (const name of original.getAttributeNames()) {
          if (name.toLowerCase().startsWith('on')) original.removeAttribute(name);
        }
        outElement.replaceWith(original);
        this.nodeMarkers.set(original, marker);
      } else {
        // A tag the translation introduced with no source counterpart: keep the
        // freshly parsed node, but record its marker for future re-translates.
        this.nodeMarkers.set(outElement, marker);
      }
    }

    element.replaceChildren(...Array.from(fragment.childNodes));
  }

  /**
   * Map each inline-tag marker ("a0", "span1", …) to the live element it refers
   * to within `element`. On the first apply the subtree is the source, so we
   * reproduce the Masker's per-tag-name, 0-based, document-order numbering. Once
   * a subtree has been morphed its elements carry a recorded marker (nodeMarkers),
   * which we trust on re-translate so reordered/duplicate tags still map correctly.
   */
  private buildMarkerToNode(element: Element): Map<string, Element> {
    const elements: Element[] = [];
    const collect = (parent: Element): void => {
      for (const child of parent.children) {
        elements.push(child);
        collect(child);
      }
    };
    collect(element);

    const map = new Map<string, Element>();
    if (elements.length > 0 && elements.every((e) => this.nodeMarkers.has(e))) {
      for (const e of elements) map.set(this.nodeMarkers.get(e)!, e);
    } else {
      const counters = new Map<string, number>();
      for (const e of elements) {
        const tag = e.tagName.toLowerCase();
        const n = counters.get(tag) ?? 0;
        counters.set(tag, n + 1);
        map.set(`${tag}${n}`, e);
      }
    }
    return map;
  }

  /** Unmasks and writes a translated attribute value, recording what was written. */
  private applyAttributeTranslation(
    element: Element,
    attr: string,
    value: string,
    maskResult: Pick<MaskResult, 'variables' | 'tagAttributes' | 'casePattern' | 'leadingWhitespace' | 'trailingWhitespace'>,
    originalValue: string
  ): void {
    const unmasked = this.masker.unmask(value, maskResult.variables, maskResult.tagAttributes, this.config.locale, originalValue);
    const output = maskResult.leadingWhitespace + this.masker.applyCasePattern(unmasked, maskResult.casePattern) + maskResult.trailingWhitespace;
    element.setAttribute(attr, output);

    let applied = this.lastAppliedAttrs.get(element);
    if (!applied) {
      applied = new Map();
      this.lastAppliedAttrs.set(element, applied);
    }
    applied.set(attr, output);
  }

  private trackPendingNode(
    cacheKey: string,
    element: Element,
    maskResult: MaskResult,
    originalText: string,
    isHtml: boolean,
    scope?: string
  ): void {
    this.addToPendingSet(cacheKey, {
      element,
      variables: maskResult.variables,
      tagAttributes: maskResult.tagAttributes,
      casePattern: maskResult.casePattern,
      leadingWhitespace: maskResult.leadingWhitespace,
      trailingWhitespace: maskResult.trailingWhitespace,
      originalText,
      snapshot: (isHtml ? element.innerHTML : element.textContent) ?? '',
      isHtml,
      scope,
    });
  }

  private addToPendingSet(cacheKey: string, node: PendingNode): void {
    let set = this.pendingNodes.get(cacheKey);
    if (!set) {
      set = new Set();
      this.pendingNodes.set(cacheKey, set);
    }
    set.add(node);
  }

  private buildItem(
    cacheKey: string,
    originalText: string,
    variables: VariableInfo[],
    element: Element,
    source: TranslationItemDebug['source'],
    scope?: string
  ): TranslationItem {
    const item: TranslationItem = {
      masked: cacheKey,
      original: originalText,
      variables,
    };
    if (scope) {
      item.scope = scope;
    }
    if (this.config.debug) {
      item.debug = this.collectDebugInfo(element, source);
    }
    return item;
  }

  private collectDebugInfo(
    element: Element,
    source: TranslationItemDebug['source']
  ): TranslationItemDebug {
    const childElements: TranslationItemDebug['childElements'] = [];
    for (const child of element.children) {
      childElements.push({
        tag: child.tagName,
        classes: child.className,
      });
    }

    // Extract just the opening tag from outerHTML
    const outer = element.outerHTML;
    const closeIdx = outer.indexOf('>');
    const elementOpenTag = closeIdx !== -1 ? outer.slice(0, closeIdx + 1) : outer;

    return { elementOpenTag, childElements, source };
  }
}

/** Returns true if the masked text contains letters to translate (not just placeholders, tags, whitespace, or punctuation). */
function hasTranslatableContent(masked: string): boolean {
  const stripped = masked.replace(/\{\{\d+\}\}/g, '').replace(/<[^>]*>/g, '');
  return /\p{L}/u.test(stripped);
}

/** Resolves a TranslationEntry to a string given an optional scope. */
function resolveEntry(value: TranslationEntry, scope?: string): string | undefined {
  if (typeof value === 'string') return value;
  if (scope && scope in value) return value[scope];
  return undefined;
}
