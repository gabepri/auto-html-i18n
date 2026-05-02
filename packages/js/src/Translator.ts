import type { CasePattern, TranslationEntry, TranslationItem, TranslationItemDebug, OnMissingTranslationCallback, MaskResult, VariableInfo } from './types';
import { Store } from './Store';
import { Queue } from './Queue';
import { Masker } from './Masker';

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

    // Skip if this attribute was already translated
    if (element.hasAttribute(originalAttrName)) {
      return;
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
        const unmasked = this.masker.unmask(resolved, maskResult.variables, maskResult.tagAttributes, this.config.locale);
        const output = this.masker.applyCasePattern(unmasked, maskResult.casePattern);
        element.setAttribute(attr, maskResult.leadingWhitespace + output + maskResult.trailingWhitespace);
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
        const unmasked = this.masker.unmask(resolved, node.variables, node.tagAttributes, this.config.locale);
        const output = this.masker.applyCasePattern(unmasked, node.casePattern);
        node.element.setAttribute(node.attrName, node.leadingWhitespace + output + node.trailingWhitespace);
        const originalAttrName = `${this.config.originalAttribute}-${node.attrName}`;
        node.element.setAttribute(originalAttrName, node.originalText);
      } else {
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

        const cacheKey = maskResult.masked;
        const scope = this.resolveScope(element);
        const entry = this.store.get(this.config.locale, cacheKey);

        if (entry && entry.status === 'resolved' && entry.value !== null) {
          const resolved = resolveEntry(entry.value, scope);
          if (resolved) {
            const unmasked = this.masker.unmask(resolved, maskResult.variables, maskResult.tagAttributes, this.config.locale);
            const output = this.masker.applyCasePattern(unmasked, maskResult.casePattern);
            element.setAttribute(attr, maskResult.leadingWhitespace + output + maskResult.trailingWhitespace);
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
        if (isHtml) {
          element.innerHTML = originalText;
        } else {
          element.textContent = originalText;
        }
      }
      element.removeAttribute(this.config.originalAttribute);
      element.removeAttribute(this.config.pendingAttribute);
    }

    // Revert attributes
    for (const attr of this.config.translatableAttributes) {
      const originalAttrName = `${this.config.originalAttribute}-${attr}`;
      const attrElements = document.querySelectorAll(`[${originalAttrName}]`);
      for (const element of attrElements) {
        const originalValue = element.getAttribute(originalAttrName);
        if (originalValue) {
          element.setAttribute(attr, originalValue);
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
    const unmasked = this.masker.unmask(value, maskResult.variables, maskResult.tagAttributes, this.config.locale);
    const output = maskResult.leadingWhitespace + this.masker.applyCasePattern(unmasked, casePattern) + maskResult.trailingWhitespace;

    if (isHtml) {
      element.innerHTML = output;
    } else {
      element.textContent = output;
    }

    element.setAttribute(this.config.originalAttribute, originalText);
    element.removeAttribute(this.config.pendingAttribute);
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
