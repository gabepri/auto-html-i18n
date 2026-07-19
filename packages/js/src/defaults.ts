import type { IgnoreWordEntry } from './types';

/**
 * Subtrees never collected, translated, or reported.
 *
 * Beyond the obvious non-copy elements, this curates the containers browser
 * extensions inject into the page: their UI is localized to the *user's* language
 * and is never site copy, so without this it gets collected and reported as missing
 * source text (1Password's Japanese autofill hint showing up as a "missing English
 * string" is the case that prompted the list). Expect it to grow as new extensions
 * are observed in production — consumers passing a plain array keep inheriting
 * additions automatically.
 */
export const DEFAULT_IGNORE_SELECTORS: string[] = [
  'script',
  'style',
  'code',
  // 1Password's injected custom elements (inline button, autofill menu, notifications)
  'com-1password-button',
  'com-1password-menu',
  'com-1password-notification',
  // LastPass field decorations
  '[id^="__lpform"]',
  // Grammarly's editor overlay and desktop integration host
  'grammarly-extension',
  'grammarly-desktop-integration',
];

/** Inline tags preserved as `<tagN>` markers in a cache key rather than masked opaquely. */
export const DEFAULT_ALLOWED_INLINE_TAGS: string[] = [
  'a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del', 'sup', 'sub',
];

/** Attributes whose values are translated alongside text content. */
export const DEFAULT_TRANSLATABLE_ATTRIBUTES: string[] = ['title', 'placeholder', 'alt', 'aria-label'];

/** Words never translated and masked as variables instead. Empty by default. */
export const DEFAULT_IGNORE_WORDS: IgnoreWordEntry[] = [];

/** Dedupe identity of an ignore-word entry: the word itself, whichever form it takes. */
export function ignoreWordKey(entry: IgnoreWordEntry): string {
  return typeof entry === 'string' ? entry : entry.word;
}
