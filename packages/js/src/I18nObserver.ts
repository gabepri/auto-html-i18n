import type { I18nConfig, I18nStatus, IcuValidationResult, IgnoreWordEntry, TranslationEntry, TranslationItem, VariableInfo } from './types';
import { Store } from './Store';
import { Queue } from './Queue';
import { Masker } from './Masker';
import { Observer } from './Observer';
import { Translator } from './Translator';

const DEFAULTS = {
  allowedInlineTags: ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del'],
  translatableAttributes: ['title', 'placeholder', 'alt', 'aria-label'],
  ignoreSelectors: ['script', 'style', 'code'],
  ignoreWords: [] as string[],
  initialCache: {} as Record<string, TranslationEntry>,
  debounceTime: 200,
  maxBatchSize: 50,
  originalAttribute: 'data-i18n-original',
  pendingAttribute: 'data-i18n-pending',
  keyAttribute: 'data-i18n-key',
  ignoreAttribute: 'data-i18n-ignore',
  scopeAttribute: 'data-i18n-scope',
  debug: false,
};

export class I18nObserver {
  private store: Store;
  private queue: Queue;
  private masker: Masker;
  private observer: Observer;
  private translator: Translator;
  private currentLocale: string;
  private _status: I18nStatus = 'idle';
  private config: Required<I18nConfig>;

  constructor(userConfig: I18nConfig) {
    const config: Required<I18nConfig> = {
      allowedInlineTags: userConfig.allowedInlineTags ?? DEFAULTS.allowedInlineTags,
      translatableAttributes: userConfig.translatableAttributes ?? DEFAULTS.translatableAttributes,
      ignoreSelectors: userConfig.ignoreSelectors ?? DEFAULTS.ignoreSelectors,
      ignoreWords: userConfig.ignoreWords ?? DEFAULTS.ignoreWords,
      initialCache: userConfig.initialCache ?? DEFAULTS.initialCache,
      rootElement: userConfig.rootElement ?? document.body,
      debounceTime: userConfig.debounceTime ?? DEFAULTS.debounceTime,
      maxBatchSize: userConfig.maxBatchSize ?? DEFAULTS.maxBatchSize,
      originalAttribute: userConfig.originalAttribute ?? DEFAULTS.originalAttribute,
      pendingAttribute: userConfig.pendingAttribute ?? DEFAULTS.pendingAttribute,
      keyAttribute: userConfig.keyAttribute ?? DEFAULTS.keyAttribute,
      ignoreAttribute: userConfig.ignoreAttribute ?? DEFAULTS.ignoreAttribute,
      scopeAttribute: userConfig.scopeAttribute ?? DEFAULTS.scopeAttribute,
      debug: userConfig.debug ?? DEFAULTS.debug,
      locale: userConfig.locale,
      onMissingTranslation: userConfig.onMissingTranslation,
    };
    this.config = config;
    this.currentLocale = config.locale;

    // Initialize internal modules
    this.store = new Store();
    this.masker = new Masker({
      ignoreWords: config.ignoreWords,
      allowedInlineTags: config.allowedInlineTags,
    });

    this.translator = new Translator(
      this.store,
      // Queue placeholder — will be replaced below
      null as unknown as Queue,
      this.masker,
      {
        locale: config.locale,
        originalAttribute: config.originalAttribute,
        pendingAttribute: config.pendingAttribute,
        keyAttribute: config.keyAttribute,
        scopeAttribute: config.scopeAttribute,
        translatableAttributes: config.translatableAttributes,
        onMissingTranslation: config.onMissingTranslation,
        debug: config.debug,
      }
    );

    this.queue = new Queue({
      debounceTime: config.debounceTime,
      maxBatchSize: config.maxBatchSize,
      onFlush: (items: TranslationItem[]) => this.handleFlush(items),
    });

    // Now wire the queue into the translator (replace the placeholder)
    // We need to re-create the translator with the real queue
    this.translator = new Translator(
      this.store,
      this.queue,
      this.masker,
      {
        locale: config.locale,
        originalAttribute: config.originalAttribute,
        pendingAttribute: config.pendingAttribute,
        keyAttribute: config.keyAttribute,
        scopeAttribute: config.scopeAttribute,
        translatableAttributes: config.translatableAttributes,
        onMissingTranslation: config.onMissingTranslation,
        debug: config.debug,
      }
    );

    this.observer = new Observer({
      rootElement: config.rootElement,
      allowedInlineTags: config.allowedInlineTags,
      ignoreSelectors: config.ignoreSelectors,
      translatableAttributes: config.translatableAttributes,
      originalAttribute: config.originalAttribute,
      pendingAttribute: config.pendingAttribute,
      keyAttribute: config.keyAttribute,
      ignoreAttribute: config.ignoreAttribute,
      onTextFound: (element, text) => this.translator.processText(element, text),
      onAttributeFound: (element, attr, value) => this.translator.processAttribute(element, attr, value),
    });

    // Load initial cache
    if (Object.keys(config.initialCache).length > 0) {
      this.store.loadBulk(config.locale, config.initialCache);
    }
  }

  get status(): I18nStatus {
    return this._status;
  }

  start(): void {
    this.observer.start();
    this._status = 'observing';
  }

  stop(revert?: boolean): void {
    this.observer.stop();
    this.queue.clear();
    if (revert) {
      this.translator.revertAll();
    }
    this._status = 'stopped';
  }

  destroy(revert?: boolean): void {
    this.stop(revert);
    this.store.clearCache();
    this.translator.clearPending();
    this._status = 'destroyed';
  }

  setCache(locale: string, data: Record<string, TranslationEntry>): void {
    this.store.loadBulk(locale, data);
  }

  getTranslation(key: string, locale?: string): TranslationEntry | undefined {
    const loc = locale ?? this.currentLocale;
    const entry = this.store.get(loc, key);
    if (entry && entry.status === 'resolved' && entry.value !== null) {
      return entry.value;
    }
    return undefined;
  }

  translate(text: string, variables?: string[], scope?: string): string {
    // `text` is a pre-masked key like "Hello {{0}}" — look it up directly
    const entry = this.store.get(this.currentLocale, text);

    let translated: string;
    if (entry && entry.status === 'resolved' && entry.value !== null) {
      if (typeof entry.value === 'string') {
        translated = entry.value;
      } else {
        translated = (scope && entry.value[scope]) ?? text;
      }
    } else {
      translated = text;
    }

    // Substitute variables
    if (variables) {
      translated = translated.replace(/\{\{(\d+)\}\}/g, (_match, indexStr: string) => {
        const index = parseInt(indexStr, 10);
        return variables[index] ?? `{{${indexStr}}}`;
      });
    }

    return translated;
  }

  setLocale(locale: string): void {
    this.currentLocale = locale;
    this.translator.setLocale(locale);
    this.translator.retranslateAll();
  }

  /**
   * Dry-runs a translation string against the given variables, exactly as the
   * library would consume it. Defaults to the current locale.
   */
  validateIcu(translated: string, variables: VariableInfo[] = [], locale?: string): IcuValidationResult {
    return this.masker.validateIcu(translated, variables, locale ?? this.currentLocale);
  }

  /**
   * Masks `original` with this instance's config (ignoreWords, inline tags) to
   * derive its variables, then validates `translated` against them.
   */
  validateTranslation(original: string, translated: string, locale?: string): IcuValidationResult {
    return this.masker.validateTranslation(original, translated, locale ?? this.currentLocale);
  }

  getIgnoreWords(): IgnoreWordEntry[] {
    return this.masker.getIgnoreWords();
  }

  addIgnoreWords(...words: IgnoreWordEntry[]): void {
    this.masker.addIgnoreWords(...words);
    this.translator.retranslateAll();
  }

  removeIgnoreWords(...words: IgnoreWordEntry[]): void {
    this.masker.removeIgnoreWords(...words);
    this.translator.retranslateAll();
  }

  setIgnoreWords(words: IgnoreWordEntry[]): void {
    this.masker.setIgnoreWords(words);
    this.translator.retranslateAll();
  }

  getCache(locale?: string): Record<string, TranslationEntry> {
    return this.store.getCache(locale ?? this.currentLocale);
  }

  clearCache(locale?: string): void {
    this.store.clearCache(locale);
  }

  private async handleFlush(items: TranslationItem[]): Promise<void> {
    try {
      const result = await this.config.onMissingTranslation(items, this.currentLocale);
      if (result) {
        for (const [key, value] of Object.entries(result)) {
          this.store.set(this.currentLocale, key, value);
          this.translator.applyPending(key);
        }
      }
    } catch (err) {
      console.error('auto-html-i18n: translation callback error', err);
      // Mark items as reported to prevent infinite re-queuing
      for (const item of items) {
        this.store.markReported(this.currentLocale, item.masked);
      }
    }
  }
}
