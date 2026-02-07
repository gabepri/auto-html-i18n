import type { ResolverConfig, TranslationEntry } from './types';

export class Resolver {
  private context: Record<string, string>;
  private fallbackContext: Record<string, string>;
  private contextOrder: string[];

  constructor(config: ResolverConfig) {
    this.context = { ...config.context };
    this.fallbackContext = { ...config.fallbackContext };
    this.contextOrder = [...config.contextOrder];
  }

  resolve(entry: TranslationEntry): string | null {
    if (typeof entry === 'string') {
      return entry;
    }

    const keys = Object.keys(entry);
    if (keys.length === 0) {
      return null;
    }

    const candidates = this.getCandidateKeys();
    for (const candidate of candidates) {
      if (candidate in entry) {
        return entry[candidate]!;
      }
    }

    // Absolute fallback: first value in the object
    return entry[keys[0]!]!;
  }

  getCandidateKeys(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    const addKey = (key: string): void => {
      if (key && !seen.has(key)) {
        seen.add(key);
        result.push(key);
      }
    };

    // Generate keys from current context
    this.addKeysFromContext(this.context, addKey);

    // Generate keys from fallback context
    this.addKeysFromContext(this.fallbackContext, addKey);

    return result;
  }

  updateContext(context: Record<string, string>): void {
    this.context = { ...context };
  }

  updateFallbackContext(fallback: Record<string, string>): void {
    this.fallbackContext = { ...fallback };
  }

  private addKeysFromContext(
    ctx: Record<string, string>,
    addKey: (key: string) => void
  ): void {
    // Build compound key from all context dimensions in order
    const compoundParts: string[] = [];
    for (const dim of this.contextOrder) {
      const val = ctx[dim];
      if (val) {
        compoundParts.push(val);
      }
    }

    // Exact compound (all dimensions)
    if (compoundParts.length > 1) {
      addKey(compoundParts.join('_'));
    }

    // Partial keys (one dimension at a time, in contextOrder)
    for (const dim of this.contextOrder) {
      const val = ctx[dim];
      if (val) {
        addKey(val);
      }
    }
  }
}
