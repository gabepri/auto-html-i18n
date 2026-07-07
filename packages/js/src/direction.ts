import type { TextDirection } from './types';

/** Languages written right-to-left in their default script. */
const RTL_LANGUAGES = new Set([
  'ar', // Arabic
  'arc', // Aramaic
  'ckb', // Sorani Kurdish
  'dv', // Divehi
  'fa', // Persian
  'glk', // Gilaki
  'he', // Hebrew
  'iw', // Hebrew (legacy code)
  'ji', // Yiddish (legacy code)
  'ks', // Kashmiri
  'mzn', // Mazanderani
  'nqo', // N'Ko
  'pnb', // Western Punjabi
  'ps', // Pashto
  'sd', // Sindhi
  'ug', // Uyghur
  'ur', // Urdu
  'ydd', // Eastern Yiddish
  'yi', // Yiddish
]);

/** ISO 15924 script codes written right-to-left. */
const RTL_SCRIPTS = new Set([
  'adlm', // Adlam
  'arab', // Arabic
  'aran', // Arabic (Nastaliq)
  'hebr', // Hebrew
  'mand', // Mandaic
  'mend', // Mende Kikakui
  'nkoo', // N'Ko
  'rohg', // Hanifi Rohingya
  'samr', // Samaritan
  'syrc', // Syriac
  'thaa', // Thaana
  'yezi', // Yezidi
]);

/**
 * Resolves the writing direction of a locale tag (BCP 47; underscore
 * separators are tolerated). An explicit script subtag wins over the
 * language's default: `ar-Latn` is ltr, `az-Arab` is rtl.
 */
export function getLocaleDirection(locale: string): TextDirection {
  const subtags = locale.toLowerCase().split(/[-_]/);
  for (let i = 1; i < subtags.length; i++) {
    if (/^[a-z]{4}$/.test(subtags[i]!)) {
      return RTL_SCRIPTS.has(subtags[i]!) ? 'rtl' : 'ltr';
    }
  }
  return RTL_LANGUAGES.has(subtags[0] ?? '') ? 'rtl' : 'ltr';
}
