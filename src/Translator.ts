import type { TranslationEntry, OnMissingTranslationCallback, MaskResult } from './types';
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

    element.setAttribute(this.config.pendingAttribute, '');

    if (entry && (entry.status === 'pending' || entry.status === 'reported')) {
      this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml);
      return;
    }

    this.store.markPending(this.config.locale, cacheKey);
    this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml);
    this.queue.enqueue({
      masked: cacheKey,
      original: originalText,
      variables: maskResult.variables,
    });
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
      this.queue.enqueue({
        masked: cacheKey,
        original: originalValue,
        variables: maskResult.variables,
      });
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
        element.setAttribute(this.config.pendingAttribute, '');
        this.store.markPending(this.config.locale, cacheKey);
        this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml);
        this.queue.enqueue({
          masked: cacheKey,
          original: originalText,
          variables: maskResult.variables,
        });
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
}
