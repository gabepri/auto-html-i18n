// ---- Translation Types ----

/** Maps scope names to translated strings */
export type ScopedTranslation = Record<string, string>;

/** A translation can be a plain string or a scope-keyed object */
export type TranslationEntry = string | ScopedTranslation;

/** DOM context included when debug mode is enabled */
export interface TranslationItemDebug {
  elementOpenTag: string;
  childElements: Array<{ tag: string; classes: string }>;
  source: 'text' | `attribute:${string}`;
}

/** The detected type of a masked variable */
export type VariableType = 'ignoreWord' | 'number' | 'date' | 'url' | 'email' | 'symbol' | 'comment' | 'markup' | 'ignored';

/** Describes a masked variable with its detected type and optional metadata */
export interface VariableInfo {
  value: string;
  type: VariableType;
  meta?: Record<string, string>;
}

/** Item sent to the onMissingTranslation callback */
export interface TranslationItem {
  masked: string;
  original: string;
  variables: VariableInfo[];
  scope?: string;
  debug?: TranslationItemDebug;
}

/** The callback signature for missing translations */
export type OnMissingTranslationCallback = (
  items: TranslationItem[],
  locale: string
) => Promise<Record<string, TranslationEntry> | null>;

// ---- Status Types ----

export type I18nStatus = 'idle' | 'observing' | 'stopped' | 'destroyed';

// ---- Direction Types ----

export type TextDirection = 'ltr' | 'rtl';

// ---- Configuration Types ----

/**
 * How every list-valued config option is supplied. One convention, no per-option flags:
 *
 * - A plain array is **unioned** with the library's defaults (deduplicated), so you get
 *   "all the defaults plus mine" without knowing what the defaults are — and you keep
 *   inheriting entries added in later releases.
 * - A function gets the defaults and its return value is used **verbatim**, for removing
 *   one entry (`(d) => d.filter(s => s !== 'code')`), reordering, or replacing the list
 *   outright (`() => ['mine']`).
 *
 * Each option's defaults are exported as a named constant (e.g. `DEFAULT_IGNORE_SELECTORS`).
 */
export type ListOption<T> = T[] | ((defaults: T[]) => T[]);

export interface I18nConfig {
  locale: string;
  onMissingTranslation: OnMissingTranslationCallback;
  /** {@link ListOption} over `DEFAULT_ALLOWED_INLINE_TAGS`. */
  allowedInlineTags?: ListOption<string>;
  /** {@link ListOption} over `DEFAULT_TRANSLATABLE_ATTRIBUTES`. */
  translatableAttributes?: ListOption<string>;
  /** {@link ListOption} over `DEFAULT_IGNORE_SELECTORS`. */
  ignoreSelectors?: ListOption<string>;
  /** {@link ListOption} over `DEFAULT_IGNORE_WORDS` (empty by default). */
  ignoreWords?: ListOption<IgnoreWordEntry>;
  initialCache?: Record<string, TranslationEntry>;
  rootElement?: HTMLElement;
  debounceTime?: number;
  maxBatchSize?: number;
  originalAttribute?: string;
  pendingAttribute?: string;
  keyAttribute?: string;
  ignoreAttribute?: string;
  scopeAttribute?: string;
  /** When true, keep dir/lang on directionElement in sync with the locale */
  manageDirection?: boolean;
  /** Element whose dir/lang are managed; defaults to document.documentElement */
  directionElement?: HTMLElement;
  /**
   * Skip reporting masks captured from a half-rendered UI ("Level undefined",
   * "about NaN minutes", "results for ''"). Such text is still rendered as-is —
   * there is nothing to translate it to — but never reaches onMissingTranslation.
   * Defaults to true. See `isUnrenderedValue` to override the detection.
   */
  skipUnrenderedValues?: boolean;
  /**
   * Overrides the half-rendered-value detection. Use it when your copy legitimately
   * contains "null"/"undefined"/empty quotes. Ignored when `skipUnrenderedValues`
   * is false.
   */
  isUnrenderedValue?: UnrenderedValuePredicate;
  /**
   * How to coexist with external/browser page translation (Chrome auto-translate,
   * Edge, translation extensions). Defaults to `'protect-translations'`.
   * See {@link ExternalTranslationLevel}.
   */
  externalTranslation?: ExternalTranslationLevel;
  /**
   * Translator signals evaluated by the detector, so a new translator can be reacted
   * to without a library release. A {@link ListOption} over `EXTERNAL_TRANSLATOR_SIGNALS`,
   * deduplicated by `id` (yours wins). Ignored at `externalTranslation: 'allow'`.
   */
  translatorSignals?: ListOption<ExternalTranslatorSignal>;
  debug?: boolean;
}

/**
 * {@link I18nConfig} after defaults are applied and every {@link ListOption} has been
 * resolved to a concrete list — the shape the internals consume.
 */
export type ResolvedI18nConfig = Omit<
  Required<I18nConfig>,
  'allowedInlineTags' | 'translatableAttributes' | 'ignoreSelectors' | 'ignoreWords' | 'translatorSignals'
> & {
  allowedInlineTags: string[];
  translatableAttributes: string[];
  ignoreSelectors: string[];
  ignoreWords: IgnoreWordEntry[];
  translatorSignals: ExternalTranslatorSignal[];
};

/** Decides whether a mask is an artifact of a half-rendered UI and must not be reported. */
export type UnrenderedValuePredicate = (masked: string, original: string) => boolean;

// ---- External translation coexistence ----

/**
 * How hard to push back on an external page translator (Chrome/Edge auto-translate,
 * translation extensions). Levels are cumulative — each includes everything below it:
 *
 * - `'allow'`: do nothing (pre-existing behavior; detection is skipped entirely).
 * - `'suppress-reports'`: detect an engaged translator and stop reporting missing
 *   translations while it is active — its rewritten output would otherwise be
 *   collected as bogus "source" strings. Cache lookups and applying our own
 *   translations continue.
 * - `'protect-translations'` (default): additionally mark every element we translate
 *   with `translate="no"` + the `notranslate` class so the browser re-translates
 *   neither our output; untranslated content stays unmarked on purpose so the
 *   browser may translate it.
 * - `'block'`: additionally stamp `document.documentElement` with `translate="no"`,
 *   the `notranslate` class and the `<meta name="google" content="notranslate">`
 *   head tag at start, opting the whole page out of external translation. Not the
 *   default because it strands users whose languages the consumer doesn't serve.
 */
export type ExternalTranslationLevel = 'allow' | 'suppress-reports' | 'protect-translations' | 'block';

/**
 * Declarative description of one known external page translator. Detection is a
 * generic engine evaluating these against the mutation stream the observer already
 * processes (plus one attribute observer on the root element): supporting another
 * translator means appending a constant to `EXTERNAL_TRANSLATOR_SIGNALS` — or
 * passing `translatorSignals` in config — never touching engine code.
 */
export interface ExternalTranslatorSignal {
  /** Stable identifier, e.g. 'chrome-translate'; surfaced in the debug state. */
  id: string;
  /**
   * Classes the tool stamps on `document.documentElement` while engaged. Presence
   * activates the signal; for non-sticky signals, removal clears it again (the only
   * signal kind that can self-clear).
   */
  rootClasses?: string[];
  /** Attribute names the tool stamps on elements it rewrites, seen as attribute mutations. */
  mutationAttributes?: string[];
  /** Selector matching nodes the tool injects into the page (checked on added nodes and their subtrees). */
  insertedNodeSelector?: string;
  /** Once seen, the signal stays active for the session — for tools with no reliable off-signal. */
  sticky?: boolean;
}

// ---- Masker Types ----

/** An ignore word can be a plain string or an object with metadata */
export type IgnoreWordEntry = string | { word: string; meta?: Record<string, string> };

export type CasePattern = 'lower' | 'upper' | 'mixed';

export interface MaskResult {
  masked: string;
  variables: VariableInfo[];
  tagAttributes: Map<string, Record<string, string>>;
  casePattern: CasePattern;
  leadingWhitespace: string;
  trailingWhitespace: string;
}

export interface MaskerConfig {
  ignoreWords: IgnoreWordEntry[];
  allowedInlineTags: string[];
}

/** How the library will treat a translation string when consuming it */
export type TranslationFormat = 'icu' | 'simple' | 'plain';

/** Result of dry-run validating a translation string against variables */
export interface IcuValidationResult {
  valid: boolean;
  format: TranslationFormat;
  /** Failure reason when invalid; wording is engine-specific */
  error?: string;
  /** What consumption would render, present when valid */
  output?: string;
}

// ---- Store Types ----

export type EntryStatus = 'pending' | 'resolved' | 'reported';

export interface StoreEntry {
  value: TranslationEntry | null;
  status: EntryStatus;
}

// ---- Queue Types ----

export interface QueueConfig {
  debounceTime: number;
  maxBatchSize: number;
  onFlush: (items: TranslationItem[]) => Promise<void>;
}

// ---- Observer Types ----

export interface ObserverConfig {
  rootElement: HTMLElement;
  allowedInlineTags: string[];
  ignoreSelectors: string[];
  translatableAttributes: string[];
  originalAttribute: string;
  pendingAttribute: string;
  keyAttribute: string;
  ignoreAttribute: string;
  /** `textNode` is the specific leaf Text node the unit lives in; absent for aggregated (innerHTML) units. */
  onTextFound: (element: Element, text: string, textNode?: Text) => void;
  onAttributeFound: (element: Element, attr: string, value: string) => void;
  /**
   * Attribute names to observe on top of `translatableAttributes` — mutations on
   * them reach `onMutations` but are never treated as translatable content. Used
   * for external-translator signal attributes.
   */
  extraObservedAttributes?: string[];
  /** Sees every mutation batch before it is processed (external-translator signal evaluation). */
  onMutations?: (mutations: MutationRecord[]) => void;
}

