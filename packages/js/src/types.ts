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

export interface I18nConfig {
  locale: string;
  onMissingTranslation: OnMissingTranslationCallback;
  allowedInlineTags?: string[];
  translatableAttributes?: string[];
  ignoreSelectors?: string[];
  ignoreWords?: IgnoreWordEntry[];
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
  debug?: boolean;
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
  onTextFound: (element: Element, text: string) => void;
  onAttributeFound: (element: Element, attr: string, value: string) => void;
}

