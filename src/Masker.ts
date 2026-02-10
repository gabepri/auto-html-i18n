import { IntlMessageFormat } from 'intl-messageformat';
import type { CasePattern, IgnoreWordEntry, MaskerConfig, MaskResult, VariableInfo, VariableType } from './types';

interface IgnoreWordInternal {
  word: string;
  meta?: Record<string, string>;
}

export class Masker {
  private ignoreWords: IgnoreWordInternal[];
  private allowedInlineTags: Set<string>;
  private variableRegex: RegExp;
  private groupTypeMap: VariableType[] = [];

  constructor(config: MaskerConfig) {
    // Normalize and sort ignoreWords longest-first for greedy matching
    this.ignoreWords = normalizeIgnoreWords(config.ignoreWords)
      .sort((a, b) => b.word.length - a.word.length);
    this.allowedInlineTags = new Set(config.allowedInlineTags);
    this.variableRegex = this.buildVariableRegex();
  }

  mask(text: string): MaskResult {
    if (text === '') {
      return { masked: '', variables: [], tagAttributes: new Map(), casePattern: 'lower', leadingWhitespace: '', trailingWhitespace: '' };
    }

    // Phase 1: Normalize inline tags (strip attributes, assign indices)
    const tagAttributes = new Map<string, Record<string, string>>();
    const tagCounters = new Map<string, number>();
    // Map from original tag index marker to its key (e.g. "a0")
    const tagMapping = new Map<string, string>();

    // Process opening tags of allowed inline elements
    let tagProcessed = text.replace(
      /<(\w+)(\s[^>]*)?\s*>/g,
      (match, tagName: string, attrString: string | undefined) => {
        const lowerTag = tagName.toLowerCase();
        if (!this.allowedInlineTags.has(lowerTag)) {
          return match; // Leave non-allowed tags as-is
        }

        const count = tagCounters.get(lowerTag) ?? 0;
        tagCounters.set(lowerTag, count + 1);
        const tagKey = `${lowerTag}${count}`;

        // Parse attributes
        const attrs: Record<string, string> = {};
        if (attrString) {
          const attrRegex = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
          let attrMatch;
          while ((attrMatch = attrRegex.exec(attrString)) !== null) {
            const attrName = attrMatch[1]!;
            const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
            attrs[attrName] = attrValue;
          }
        }

        tagAttributes.set(tagKey, attrs);
        tagMapping.set(tagKey, tagKey);
        return `<${tagKey}>`;
      }
    );

    // Process closing tags of allowed inline elements
    // We need to match closing tags to the correct indexed opening tags
    const closingTagCounters = new Map<string, number>();
    tagProcessed = tagProcessed.replace(
      /<\/(\w+)\s*>/g,
      (match, tagName: string) => {
        const lowerTag = tagName.toLowerCase();
        if (!this.allowedInlineTags.has(lowerTag)) {
          return match;
        }

        const count = closingTagCounters.get(lowerTag) ?? 0;
        closingTagCounters.set(lowerTag, count + 1);
        return `</${lowerTag}${count}>`;
      }
    );

    // Phase 2: Mask variables (ignoreWords, dates, numbers)
    // We need to skip content inside < > to avoid matching tag index numbers
    const variables: VariableInfo[] = [];
    let masked = '';
    let i = 0;
    while (i < tagProcessed.length) {
      // Mask HTML comments as variables
      if (tagProcessed.startsWith('<!--', i)) {
        const closeIdx = tagProcessed.indexOf('-->', i + 4);
        if (closeIdx !== -1) {
          const comment = tagProcessed.slice(i, closeIdx + 3);
          const index = variables.length;
          variables.push({ value: comment, type: 'comment' });
          masked += `{{${index}}}`;
          i = closeIdx + 3;
          continue;
        }
      }

      // Skip over tag contents (< ... >)
      if (tagProcessed[i] === '<') {
        const closeIdx = tagProcessed.indexOf('>', i);
        if (closeIdx !== -1) {
          masked += tagProcessed.slice(i, closeIdx + 1);
          i = closeIdx + 1;
          continue;
        }
      }

      // Try to match variable regex at current position
      this.variableRegex.lastIndex = i;
      const match = this.variableRegex.exec(tagProcessed);

      if (match && match.index === i) {
        const index = variables.length;
        variables.push(this.buildVariableInfo(match));
        masked += `{{${index}}}`;
        i += match[0].length;
      } else {
        // Copy character and advance
        masked += tagProcessed[i];
        i++;
      }
    }

    const casePattern = detectCasePattern(masked);
    if (casePattern === 'upper') {
      masked = masked.toLowerCase();
    }

    // Trim leading/trailing whitespace from the key, preserving it for restoration
    const leadingMatch = /^\s+/.exec(masked);
    const trailingMatch = /\s+$/.exec(masked);
    const leadingWhitespace = leadingMatch ? leadingMatch[0] : '';
    const trailingWhitespace = trailingMatch ? trailingMatch[0] : '';
    if (leadingWhitespace || trailingWhitespace) {
      masked = masked.slice(
        leadingWhitespace.length,
        masked.length - trailingWhitespace.length
      );
    }

    return { masked, variables, tagAttributes, casePattern, leadingWhitespace, trailingWhitespace };
  }

  applyCasePattern(text: string, casePattern: CasePattern): string {
    if (casePattern !== 'upper') return text;

    let result = '';
    let inTag = false;
    for (const char of text) {
      if (char === '<') inTag = true;
      result += inTag ? char : char.toUpperCase();
      if (char === '>') inTag = false;
    }
    return result;
  }

  unmask(
    translated: string,
    variables: VariableInfo[],
    tagAttributes: Map<string, Record<string, string>>,
    locale?: string
  ): string {
    if (translated === '') {
      return '';
    }

    // Phase 1: Detect format and restore variables
    // {{N}} = simple substitution (our format), {N} or {N, plural/select, ...} = ICU
    const hasDoubleBrace = /\{\{\d+\}\}/.test(translated);
    const isICU = !hasDoubleBrace && /\{\d+/.test(translated);

    let result: string;

    if (isICU && locale) {
      try {
        result = this.evaluateICU(translated, variables, locale);
      } catch {
        // Fallback: return raw pattern on ICU evaluation error
        result = translated;
      }
    } else {
      // Simple substitution
      result = translated.replace(/\{\{(\d+)\}\}/g, (_match, indexStr: string) => {
        const index = parseInt(indexStr, 10);
        return variables[index]?.value ?? `{{${indexStr}}}`;
      });
    }

    // Phase 2: Restore tag attributes
    // Replace <tagN> with <tag attrs...> and </tagN> with </tag>
    result = result.replace(
      /<(\w+?)(\d+)>/g,
      (_match, tagName: string, indexStr: string) => {
        const tagKey = `${tagName}${indexStr}`;
        const attrs = tagAttributes.get(tagKey);
        if (attrs === undefined) {
          return `<${tagName}${indexStr}>`; // Not a known tag, leave as-is
        }

        // Build attribute string, filtering out event handlers
        const safeAttrs = Object.entries(attrs)
          .filter(([name]) => !name.toLowerCase().startsWith('on'))
          .map(([name, value]) => `${name}="${value}"`)
          .join(' ');

        if (safeAttrs) {
          return `<${tagName} ${safeAttrs}>`;
        }
        return `<${tagName}>`;
      }
    );

    // Replace closing tags: </tagN> -> </tag>
    result = result.replace(
      /<\/(\w+?)(\d+)>/g,
      (_match, tagName: string, indexStr: string) => {
        const tagKey = `${tagName}${indexStr}`;
        if (tagAttributes.has(tagKey)) {
          return `</${tagName}>`;
        }
        return `</${tagName}${indexStr}>`; // Not a known tag, leave as-is
      }
    );

    // Phase 3: Sanitize — escape any HTML tags not in the allowlist
    result = this.sanitizeTags(result);

    return result;
  }

  getIgnoreWords(): IgnoreWordEntry[] {
    return this.ignoreWords.map(w => w.meta ? { word: w.word, meta: w.meta } : w.word);
  }

  addIgnoreWords(...words: IgnoreWordEntry[]): void {
    const normalized = normalizeIgnoreWords(words);
    const existing = new Set(this.ignoreWords.map(w => w.word));
    let changed = false;
    for (const entry of normalized) {
      if (entry.word && !existing.has(entry.word)) {
        existing.add(entry.word);
        this.ignoreWords.push(entry);
        changed = true;
      }
    }
    if (changed) {
      this.ignoreWords.sort((a, b) => b.word.length - a.word.length);
      this.variableRegex = this.buildVariableRegex();
    }
  }

  removeIgnoreWords(...words: IgnoreWordEntry[]): void {
    const toRemove = new Set(normalizeIgnoreWords(words).map(e => e.word));
    const newList = this.ignoreWords.filter(w => !toRemove.has(w.word));
    if (newList.length !== this.ignoreWords.length) {
      this.ignoreWords = newList;
      this.variableRegex = this.buildVariableRegex();
    }
  }

  setIgnoreWords(words: IgnoreWordEntry[]): void {
    this.ignoreWords = normalizeIgnoreWords(words)
      .sort((a, b) => b.word.length - a.word.length);
    this.variableRegex = this.buildVariableRegex();
  }

  private buildVariableInfo(match: RegExpExecArray): VariableInfo {
    // Determine which capturing group matched to infer the variable type
    for (let g = 0; g < this.groupTypeMap.length; g++) {
      if (match[g + 1] !== undefined) {
        const type = this.groupTypeMap[g]!;
        if (type === 'ignoreWord') {
          const entry = this.ignoreWords.find(w => w.word === match[0]);
          if (entry?.meta) {
            return { value: match[0], type, meta: entry.meta };
          }
        }
        return { value: match[0], type };
      }
    }
    return { value: match[0], type: 'symbol' };
  }

  private evaluateICU(pattern: string, variables: VariableInfo[], locale: string): string {
    // Temporarily replace all HTML tags to prevent ICU parser conflicts
    const tagPlaceholders: [string, string][] = [];
    const icuPattern = pattern.replace(/<\/?[^>]+>/g, (match) => {
      const placeholder = `\uFFFD${tagPlaceholders.length}\uFFFD`;
      tagPlaceholders.push([placeholder, match]);
      return placeholder;
    });

    const mf = new IntlMessageFormat(icuPattern, locale);
    const args: Record<string, string | number> = {};

    for (let i = 0; i < variables.length; i++) {
      const vi = variables[i]!;
      // Parse numbers for proper ICU plural rule evaluation
      if (vi.type === 'number') {
        args[String(i)] = parseFloat(vi.value);
      } else {
        args[String(i)] = vi.value;
      }
      // Add metadata as {N_key} arguments (e.g. {0_gender})
      if (vi.meta) {
        for (const [key, val] of Object.entries(vi.meta)) {
          args[`${i}_${key}`] = val;
        }
      }
    }

    let result = mf.format(args) as string;

    // Restore indexed tags
    for (const [placeholder, original] of tagPlaceholders) {
      result = result.replace(placeholder, original);
    }

    return result;
  }

  private sanitizeTags(html: string): string {
    return html.replace(
      /<\/?(\w+)(\s[^>]*)?\s*>/g,
      (match, tagName: string) => {
        if (this.allowedInlineTags.has(tagName.toLowerCase())) {
          return match;
        }
        return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
    );
  }

  private buildVariableRegex(): RegExp {
    const groups: string[] = [];
    this.groupTypeMap = [];

    // 1. IgnoreWords (longest first, word boundaries)
    if (this.ignoreWords.length > 0) {
      const alts = this.ignoreWords.map(w => escapeRegex(w.word)).join('|');
      groups.push(`(${alts})`);
      this.groupTypeMap.push('ignoreWord');
    }

    // 2. URLs (must come before dates/numbers to match as a whole)
    groups.push('(https?://[^\\s<>]+)');
    this.groupTypeMap.push('url');

    // 3. Email addresses (must come before dates/numbers)
    groups.push('([a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,})');
    this.groupTypeMap.push('email');

    // 4. Date patterns (must come before number patterns)
    // Matches: MM/DD/YYYY, YYYY-MM-DD, DD.MM.YYYY, etc.
    groups.push('(\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4})');
    this.groupTypeMap.push('date');

    // 5. Numbers (including negative and decimals)
    groups.push('(-?\\d+(?:\\.\\d+)?)');
    this.groupTypeMap.push('number');

    // 6. Standalone symbols (©, ®, ™, currency, etc.) — not translatable
    groups.push('([©®™$€£¥¢₹₽§¶†‡•°±¤%])');
    this.groupTypeMap.push('symbol');

    if (groups.length === 0) {
      return /(?!)/; // Never matches
    }

    return new RegExp(groups.join('|'), 'g');
  }
}

function normalizeIgnoreWords(entries: IgnoreWordEntry[]): IgnoreWordInternal[] {
  return entries.map(e => typeof e === 'string' ? { word: e } : e);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectCasePattern(masked: string): CasePattern {
  // Strip placeholders and all HTML tags to get only translatable text
  const textOnly = masked.replace(/\{\{\d+\}\}/g, '').replace(/<[^>]*>/g, '');
  // Extract only Unicode letters
  const letters = textOnly.replace(/[^\p{L}]/gu, '');

  if (letters.length === 0) return 'lower';

  const upper = letters.toUpperCase();
  const lower = letters.toLowerCase();

  // Caseless scripts (CJK, Arabic, etc.) — no case distinction
  if (upper === lower) return 'lower';

  if (letters === upper) return 'upper';
  if (letters === lower) return 'lower';

  return 'mixed';
}
