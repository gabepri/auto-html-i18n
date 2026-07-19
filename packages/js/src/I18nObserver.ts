import type { ExternalTranslationLevel, ExternalTranslatorSignal, I18nConfig, I18nStatus, IcuValidationResult, IgnoreWordEntry, TextDirection, TranslationEntry, TranslationItem, UnrenderedValuePredicate, VariableInfo } from './types';
import { getLocaleDirection } from './direction';
import { Store } from './Store';
import { Queue } from './Queue';
import { Masker } from './Masker';
import { Observer } from './Observer';
import { Translator } from './Translator';
import { isInsideIgnored, serializeAggregate, type IgnorePredicateConfig } from './ignore';
import { isUnrenderedValue } from './unrendered';
import { ExternalTranslationDetector, EXTERNAL_TRANSLATOR_SIGNALS } from './external';

const DEFAULTS = {
  allowedInlineTags: ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del', 'sup', 'sub'],
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
  manageDirection: false,
  skipUnrenderedValues: true,
  isUnrenderedValue,
  externalTranslation: 'protect-translations' as ExternalTranslationLevel,
  extraTranslatorSignals: [] as ExternalTranslatorSignal[],
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
  // dir/lang of directionElement before we first touched them; null = untouched
  private savedDirection: { dir: string | null; lang: string | null } | null = null;
  // External-translator detection; null at 'allow' (evaluation skipped entirely)
  private detector: ExternalTranslationDetector | null;
  // Root state before 'block' stamped it; null = untouched. metaAdded is the meta
  // element we inserted (null when the author already had one).
  private savedRootBlock: {
    translate: string | null;
    hadNotranslateClass: boolean;
    metaAdded: HTMLMetaElement | null;
  } | null = null;

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
      manageDirection: userConfig.manageDirection ?? DEFAULTS.manageDirection,
      directionElement: userConfig.directionElement ?? document.documentElement,
      skipUnrenderedValues: userConfig.skipUnrenderedValues ?? DEFAULTS.skipUnrenderedValues,
      isUnrenderedValue: userConfig.isUnrenderedValue ?? DEFAULTS.isUnrenderedValue,
      externalTranslation: userConfig.externalTranslation ?? DEFAULTS.externalTranslation,
      extraTranslatorSignals: userConfig.extraTranslatorSignals ?? DEFAULTS.extraTranslatorSignals,
      debug: userConfig.debug ?? DEFAULTS.debug,
      locale: userConfig.locale,
      onMissingTranslation: userConfig.onMissingTranslation,
    };
    this.config = config;
    this.currentLocale = config.locale;

    const ignorePredicate: IgnorePredicateConfig = {
      ignoreAttribute: config.ignoreAttribute,
      ignoreSelectors: config.ignoreSelectors,
    };
    // Gate on reporting only: a half-rendered mask is rendered as-is but never sent to
    // onMissingTranslation. Off entirely when the consumer disables the gate.
    const isUnrendered: UnrenderedValuePredicate = config.skipUnrenderedValues
      ? config.isUnrenderedValue
      : () => false;

    // Initialize internal modules
    this.store = new Store();
    this.masker = new Masker({
      ignoreWords: config.ignoreWords,
      allowedInlineTags: config.allowedInlineTags,
    });

    // External-translator detection ('suppress-reports' and up). On the
    // transition to active, collected-but-unflushed entries are dropped, not
    // flushed — junk comes exclusively from mutations after the rewrite.
    this.detector = config.externalTranslation === 'allow'
      ? null
      : new ExternalTranslationDetector({
          signals: [...EXTERNAL_TRANSLATOR_SIGNALS, ...config.extraTranslatorSignals],
          onActivate: () => this.dropUnflushed(),
        });

    const translatorConfig = {
      locale: config.locale,
      originalAttribute: config.originalAttribute,
      pendingAttribute: config.pendingAttribute,
      keyAttribute: config.keyAttribute,
      scopeAttribute: config.scopeAttribute,
      translatableAttributes: config.translatableAttributes,
      onMissingTranslation: config.onMissingTranslation,
      debug: config.debug,
      serializeAggregate: (element: Element) => serializeAggregate(element, ignorePredicate),
      ignorePredicate,
      isUnrendered,
      isReportingSuppressed: () => this.detector?.isActive ?? false,
      protectTranslations:
        config.externalTranslation === 'protect-translations' || config.externalTranslation === 'block',
    };

    this.translator = new Translator(
      this.store,
      // Queue placeholder — will be replaced below
      null as unknown as Queue,
      this.masker,
      translatorConfig
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
      { ...translatorConfig }
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
      onTextFound: (element, text, textNode) => this.translator.processText(element, text, textNode),
      onAttributeFound: (element, attr, value) => this.translator.processAttribute(element, attr, value),
      extraObservedAttributes: this.detector?.observedAttributes,
      onMutations: this.detector ? (mutations) => this.detector!.evaluateMutations(mutations) : undefined,
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
    this.applyDirection();
    // Root blocking must land before the first translation lands, and detection
    // must precede the initial walk so an already-engaged translator (observer
    // restarted mid-session) suppresses from the first collection onward.
    this.applyRootBlock();
    this.detector?.start();
    this.observer.start();
    this._status = 'observing';
  }

  stop(revert?: boolean): void {
    this.observer.stop();
    this.detector?.stop();
    this.queue.clear();
    if (revert) {
      this.translator.revertAll();
      this.restoreDirection();
      this.restoreRootBlock();
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
    this.applyDirection();
    this.translator.retranslateAll();
  }

  /** Writing direction of the given locale, defaulting to the current one. */
  getDirection(locale?: string): TextDirection {
    return getLocaleDirection(locale ?? this.currentLocale);
  }

  private applyDirection(): void {
    if (!this.config.manageDirection) return;
    const el = this.config.directionElement;
    if (this.savedDirection === null) {
      this.savedDirection = { dir: el.getAttribute('dir'), lang: el.getAttribute('lang') };
    }
    el.setAttribute('dir', getLocaleDirection(this.currentLocale));
    el.setAttribute('lang', this.currentLocale);
  }

  private restoreDirection(): void {
    if (this.savedDirection === null) return;
    const el = this.config.directionElement;
    for (const [attr, value] of Object.entries(this.savedDirection)) {
      if (value === null) {
        el.removeAttribute(attr);
      } else {
        el.setAttribute(attr, value);
      }
    }
    this.savedDirection = null;
  }

  /** Diagnostic snapshot of external-translator detection (always inactive at 'allow'). */
  getExternalTranslationState(): { active: boolean; signals: string[] } {
    return {
      active: this.detector?.isActive ?? false,
      signals: this.detector?.activeSignals ?? [],
    };
  }

  // 'block' only. All three markers because support is uneven: the google meta
  // alone is unreliable in recent Chrome (crbug 329233123); translate="no" is the
  // W3C signal Edge and (partially) Firefox honor. Saves the prior root state so
  // stop(true) restores exactly what the author had — independent of the
  // manageDirection save/restore, which owns dir/lang on the same element.
  private applyRootBlock(): void {
    if (this.config.externalTranslation !== 'block') return;
    const el = document.documentElement;
    if (this.savedRootBlock === null) {
      this.savedRootBlock = {
        translate: el.getAttribute('translate'),
        hadNotranslateClass: el.classList.contains('notranslate'),
        metaAdded: null,
      };
    }
    el.setAttribute('translate', 'no');
    el.classList.add('notranslate');
    if (!document.head.querySelector('meta[name="google"][content="notranslate"]')) {
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'google');
      meta.setAttribute('content', 'notranslate');
      document.head.appendChild(meta);
      this.savedRootBlock.metaAdded = meta;
    }
  }

  private restoreRootBlock(): void {
    if (this.savedRootBlock === null) return;
    const el = document.documentElement;
    const saved = this.savedRootBlock;
    if (saved.translate === null) {
      el.removeAttribute('translate');
    } else {
      el.setAttribute('translate', saved.translate);
    }
    if (!saved.hadNotranslateClass) el.classList.remove('notranslate');
    saved.metaAdded?.remove();
    this.savedRootBlock = null;
  }

  // An external translator just engaged: what sits in the queue may already be
  // its rewritten output, so drop it. Resetting the pending state (not leaving it
  // marked) lets the same string report normally once the state clears — e.g.
  // after Chrome's "Show original".
  private dropUnflushed(): void {
    this.dropItems(this.queue.drain());
  }

  private dropItems(items: TranslationItem[]): void {
    for (const item of items) {
      this.store.resetIfPending(this.currentLocale, item.masked);
      this.translator.dropPending(item.masked);
    }
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
    // Defense-in-depth behind the enqueue-time gate: a chunk reaching us after a
    // translator engaged mid-flush must drop, not report.
    if (this.detector?.isActive) {
      this.dropItems(items);
      return;
    }

    // Re-validate against the current DOM: drop items whose tracked nodes all
    // became ignored or detached during the debounce window (portalled/late-
    // mounted content). See Translator.filterReportable.
    const reportable = this.translator.filterReportable(items, (node) =>
      isInsideIgnored(node, {
        rootElement: this.config.rootElement,
        ignoreAttribute: this.config.ignoreAttribute,
        ignoreSelectors: this.config.ignoreSelectors,
      })
    );

    if (reportable.length === 0) return;

    try {
      const result = await this.config.onMissingTranslation(reportable, this.currentLocale);
      if (result) {
        for (const [key, value] of Object.entries(result)) {
          this.store.set(this.currentLocale, key, value);
          this.translator.applyPending(key);
        }
      }
      // Anything we asked about and didn't get back is declined: mark it reported so
      // it isn't re-queued, and release its tracked nodes. Nothing can ever apply
      // them (applyPending only runs for keys the callback returned), so leaving them
      // tracked would pin detached DOM for the life of the page.
      for (const item of reportable) {
        if (!this.store.isResolved(this.currentLocale, item.masked)) {
          this.markDeclined(item.masked);
        }
      }
    } catch (err) {
      console.error('auto-html-i18n: translation callback error', err);
      // Mark items as reported to prevent infinite re-queuing
      for (const item of reportable) {
        this.markDeclined(item.masked);
      }
    }
  }

  private markDeclined(key: string): void {
    this.store.markReported(this.currentLocale, key);
    this.translator.dropPending(key);
  }
}
