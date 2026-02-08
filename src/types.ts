// ---- Translation Types ----

/** A translation can be a simple string or a variant object */
export type TranslationEntry = string | VariantObject;

/** Maps variant keys (e.g. "female_formal") to translated strings */
export type VariantObject = Record<string, string>;

/** DOM context included when debug mode is enabled */
export interface TranslationItemDebug {
  elementOpenTag: string;
  childElements: Array<{ tag: string; classes: string }>;
  source: 'text' | `attribute:${string}`;
}

/** Item sent to the onMissingTranslation callback */
export interface TranslationItem {
  masked: string;
  original: string;
  variables: string[];
  debug?: TranslationItemDebug;
}

/** The callback signature for missing translations */
export type OnMissingTranslationCallback = (
  items: TranslationItem[],
  locale: string
) => Promise<Record<string, TranslationEntry> | null>;

// ---- Configuration Types ----

export interface I18nConfig {
  locale: string;
  onMissingTranslation: OnMissingTranslationCallback;
  context?: Record<string, string>;
  fallbackContext?: Record<string, string>;
  contextOrder?: string[];
  allowedInlineTags?: string[];
  translatableAttributes?: string[];
  ignoreSelectors?: string[];
  ignoreWords?: string[];
  initialCache?: Record<string, TranslationEntry>;
  rootElement?: HTMLElement;
  debounceTime?: number;
  maxBatchSize?: number;
  originalAttribute?: string;
  pendingAttribute?: string;
  keyAttribute?: string;
  ignoreAttribute?: string;
  debug?: boolean;
}

// ---- Masker Types ----

export type CasePattern = 'lower' | 'upper' | 'mixed';

export interface MaskResult {
  masked: string;
  variables: string[];
  tagAttributes: Map<string, Record<string, string>>;
  casePattern: CasePattern;
  leadingWhitespace: string;
  trailingWhitespace: string;
}

export interface MaskerConfig {
  ignoreWords: string[];
  allowedInlineTags: string[];
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

// ---- Resolver Types ----

export interface ResolverConfig {
  context: Record<string, string>;
  fallbackContext: Record<string, string>;
  contextOrder: string[];
}
