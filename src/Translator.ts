import type { TranslationEntry, TranslationItem, TranslationItemDebug, OnMissingTranslationCallback, MaskResult } from './types';
import { Store } from './Store';
import { Queue } from './Queue';
import { Masker } from './Masker';
import { Resolver } from './Resolver';

export interface TranslatorConfig {
  locale: string;
  originalAttribute: string;
  pendingAttribute: string;
  keyAttribute: string;
  onMissingTranslation: OnMissingTranslationCallback;
  debug: boolean;
}

interface PendingNode {
  element: Element;
  variables: string[];
  tagAttributes: Map<string, Record<string, string>>;
  originalText: string;
  isAttribute?: boolean;
  attrName?: string;
  isHtml: boolean;
}

export class Translator {
  private store: Store;
  private queue: Queue;
  private masker: Masker;
  private resolver: Resolver;
  private config: TranslatorConfig;
  private pendingNodes = new Map<string, Set<PendingNode>>();

  constructor(
    store: Store,
    queue: Queue,
    masker: Masker,
    resolver: Resolver,
    config: TranslatorConfig
  ) {
    this.store = store;
    this.queue = queue;
    this.masker = masker;
    this.resolver = resolver;
    this.config = config;
  }

  processText(element: Element, originalText: string): void {
    const keyOverride = element.getAttribute(this.config.keyAttribute);
    const isHtml = /<[^>]+>/.test(originalText);
    const maskResult = this.masker.mask(originalText);
    const cacheKey = keyOverride ?? maskResult.masked;

    const entry = this.store.get(this.config.locale, cacheKey);

    if (entry && entry.status === 'resolved' && entry.value !== null) {
      this.applyTranslation(element, entry.value, maskResult, originalText, isHtml);
      return;
    }

    // Build item before mutating the element so debug info captures original state
    const item = this.buildItem(cacheKey, originalText, maskResult.variables, element, 'text');

    element.setAttribute(this.config.pendingAttribute, '');

    if (entry && (entry.status === 'pending' || entry.status === 'reported')) {
      this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml);
      return;
    }

    this.store.markPending(this.config.locale, cacheKey);
    this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml);
    this.queue.enqueue(item);
  }

  processAttribute(element: Element, attr: string, originalValue: string): void {
    const maskResult = this.masker.mask(originalValue);
    const cacheKey = maskResult.masked;

    const entry = this.store.get(this.config.locale, cacheKey);

    if (entry && entry.status === 'resolved' && entry.value !== null) {
      const resolved = this.resolver.resolve(entry.value);
      if (resolved) {
        const unmasked = this.masker.unmask(resolved, maskResult.variables, maskResult.tagAttributes);
        element.setAttribute(attr, unmasked);
      }
      return;
    }

    if (!entry) {
      this.store.markPending(this.config.locale, cacheKey);
      this.queue.enqueue(
        this.buildItem(cacheKey, originalValue, maskResult.variables, element, `attribute:${attr}`)
      );
    }

    const pendingNode: PendingNode = {
      element,
      variables: maskResult.variables,
      tagAttributes: maskResult.tagAttributes,
      originalText: originalValue,
      isAttribute: true,
      attrName: attr,
      isHtml: false,
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

      if (node.isAttribute && node.attrName) {
        const resolved = this.resolver.resolve(entry.value);
        if (resolved) {
          const unmasked = this.masker.unmask(resolved, node.variables, node.tagAttributes);
          node.element.setAttribute(node.attrName, unmasked);
        }
      } else {
        this.applyTranslation(node.element, entry.value, {
          masked: cacheKey,
          variables: node.variables,
          tagAttributes: node.tagAttributes,
        }, node.originalText, node.isHtml);
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
      const cacheKey = keyOverride ?? maskResult.masked;

      const entry = this.store.get(this.config.locale, cacheKey);
      if (entry && entry.status === 'resolved' && entry.value !== null) {
        this.applyTranslation(element, entry.value, maskResult, originalText, isHtml);
      } else if (!entry) {
        const item = this.buildItem(cacheKey, originalText, maskResult.variables, element, 'text');
        element.setAttribute(this.config.pendingAttribute, '');
        this.store.markPending(this.config.locale, cacheKey);
        this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml);
        this.queue.enqueue(item);
      }
    }
  }

  setLocale(locale: string): void {
    this.config.locale = locale;
  }

  get locale(): string {
    return this.config.locale;
  }

  private applyTranslation(
    element: Element,
    value: TranslationEntry,
    maskResult: MaskResult,
    originalText: string,
    isHtml: boolean
  ): void {
    const resolved = this.resolver.resolve(value);
    if (!resolved) return;

    const unmasked = this.masker.unmask(resolved, maskResult.variables, maskResult.tagAttributes);

    if (isHtml) {
      element.innerHTML = unmasked;
    } else {
      element.textContent = unmasked;
    }

    element.setAttribute(this.config.originalAttribute, originalText);
    element.removeAttribute(this.config.pendingAttribute);
  }

  private trackPendingNode(
    cacheKey: string,
    element: Element,
    maskResult: MaskResult,
    originalText: string,
    isHtml: boolean
  ): void {
    this.addToPendingSet(cacheKey, {
      element,
      variables: maskResult.variables,
      tagAttributes: maskResult.tagAttributes,
      originalText,
      isHtml,
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
    variables: string[],
    element: Element,
    source: TranslationItemDebug['source']
  ): TranslationItem {
    const item: TranslationItem = {
      masked: cacheKey,
      original: originalText,
      variables,
    };
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
