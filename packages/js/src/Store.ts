import type { StoreEntry, TranslationEntry } from './types';

export class Store {
  private data = new Map<string, Map<string, StoreEntry>>();

  get(locale: string, key: string): StoreEntry | undefined {
    return this.getLocaleMap(locale)?.get(key);
  }

  set(locale: string, key: string, value: TranslationEntry): void {
    const localeMap = this.ensureLocaleMap(locale);
    localeMap.set(key, { value, status: 'resolved' });
  }

  markPending(locale: string, key: string): void {
    const localeMap = this.ensureLocaleMap(locale);
    const existing = localeMap.get(key);
    // Don't overwrite resolved entries
    if (existing && existing.status === 'resolved') {
      return;
    }
    localeMap.set(key, { value: null, status: 'pending' });
  }

  markReported(locale: string, key: string): void {
    const localeMap = this.getLocaleMap(locale);
    const entry = localeMap?.get(key);
    if (entry) {
      entry.status = 'reported';
    }
  }

  /**
   * Forget a not-yet-resolved key so the same string can be collected again
   * later. Used by the flush guard when every tracked node for a key turned out
   * to be ignored/detached: leaving it `pending`/`reported` would make a later,
   * genuinely-visible occurrence short-circuit in the Translator and never get
   * reported. Resolved entries are left untouched (their translation stands).
   */
  resetIfPending(locale: string, key: string): void {
    const localeMap = this.getLocaleMap(locale);
    const entry = localeMap?.get(key);
    if (entry && entry.status !== 'resolved') {
      localeMap!.delete(key);
    }
  }

  isPending(locale: string, key: string): boolean {
    const entry = this.get(locale, key);
    return entry?.status === 'pending';
  }

  isResolved(locale: string, key: string): boolean {
    const entry = this.get(locale, key);
    return entry?.status === 'resolved';
  }

  has(locale: string, key: string): boolean {
    return this.getLocaleMap(locale)?.has(key) ?? false;
  }

  getCache(locale: string): Record<string, TranslationEntry> {
    const result: Record<string, TranslationEntry> = {};
    const localeMap = this.getLocaleMap(locale);
    if (!localeMap) return result;

    for (const [key, entry] of localeMap) {
      if (entry.status === 'resolved' && entry.value !== null) {
        result[key] = entry.value;
      }
    }
    return result;
  }

  clearCache(locale?: string): void {
    if (locale !== undefined) {
      this.data.delete(locale);
    } else {
      this.data.clear();
    }
  }

  loadBulk(locale: string, data: Record<string, TranslationEntry>): void {
    for (const [key, value] of Object.entries(data)) {
      this.set(locale, key, value);
    }
  }

  private getLocaleMap(locale: string): Map<string, StoreEntry> | undefined {
    return this.data.get(locale);
  }

  private ensureLocaleMap(locale: string): Map<string, StoreEntry> {
    let localeMap = this.data.get(locale);
    if (!localeMap) {
      localeMap = new Map();
      this.data.set(locale, localeMap);
    }
    return localeMap;
  }
}
