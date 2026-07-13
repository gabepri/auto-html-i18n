import { IntlMessageFormat } from 'intl-messageformat';
import { getLocaleDirection } from './direction';
import { IGNORE_OPEN, IGNORE_CLOSE, IGNORED_PLACEHOLDER_TAG, stripIgnoreSentinels } from './ignore';
import type { CasePattern, IcuValidationResult, IgnoreWordEntry, MaskerConfig, MaskResult, TranslationFormat, VariableInfo, VariableType } from './types';

interface IgnoreWordInternal {
  word: string;
  meta?: Record<string, string>;
}

// Invisible bidi formatting characters (marks, embeddings, isolates). Stripped
// during masking so a key stays stable when already-translated (isolate-wrapped)
// content is re-masked.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const FSI = '\u2068'; // FIRST STRONG ISOLATE
const PDI = '\u2069'; // POP DIRECTIONAL ISOLATE

// Variable types wrapped in FSI…PDI when substituted into RTL output. Comments
// are markup and symbols are direction-neutral, so neither is isolated. Ignored
// subtrees are opaque markup, so they aren't isolated either.
const BIDI_ISOLATED_TYPES = new Set<VariableType>(['ignoreWord', 'number', 'date', 'url', 'email']);

/** How unmask renders an ignored-subtree variable. */
export type IgnoredMode = 'inline' | 'placeholder';

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
    text = text.replace(BIDI_CONTROLS, '');
    if (text === '') {
      return { masked: '', variables: [], tagAttributes: new Map(), casePattern: 'lower', leadingWhitespace: '', trailingWhitespace: '' };
    }

    // Phase 0: Lift out ignored subtrees (bracketed by the aggregation
    // serializer) before any tag/variable masking sees them, so their user-data
    // text never reaches the cache key. Each region collapses to a small
    // `<k>` token — carrying no angle brackets — that phase 2 turns
    // into one opaque `ignored` variable holding the region's verbatim markup.
    const ignoredValues: string[] = [];
    if (text.indexOf(IGNORE_OPEN) !== -1) {
      const regionRe = new RegExp(`${IGNORE_OPEN}([\\s\\S]*?)${IGNORE_CLOSE}`, 'g');
      text = text.replace(regionRe, (_match, inner: string) => {
        const k = ignoredValues.length;
        ignoredValues.push(inner);
        return `${IGNORE_OPEN}${k}${IGNORE_CLOSE}`;
      });
    }

    // Phase 1: Normalize allowed inline tags — strip attributes, assign indices,
    // and match each closing tag to its opener via a stack (so nested same-name
    // tags like <span><span></span></span> keep their pairing). Non-allowed tags
    // are left raw here; phase 2 masks them as opaque `markup` variables.
    const tagAttributes = new Map<string, Record<string, string>>();
    const tagCounters = new Map<string, number>();
    const openStack: string[] = []; // tag keys (e.g. "span0") of still-open tags

    const tagProcessed = text.replace(
      /<(\/)?([a-zA-Z][\w-]*)((?:\s[^>]*?)?)\s*(\/)?>/g,
      (match, closing: string | undefined, tagName: string, attrString: string | undefined, selfClosing: string | undefined) => {
        const lowerTag = tagName.toLowerCase();
        if (!this.allowedInlineTags.has(lowerTag)) {
          return match; // non-allowed — leave raw for phase 2 to mask as markup
        }
        if (selfClosing) {
          return match; // self-closing has no pair; treat as opaque markup in phase 2
        }
        if (closing) {
          // Match to the nearest unclosed opener of the same tag name.
          for (let s = openStack.length - 1; s >= 0; s--) {
            if (openStack[s]!.replace(/\d+$/, '') === lowerTag) {
              const tagKey = openStack.splice(s, 1)[0]!;
              return `</${tagKey}>`;
            }
          }
          return match; // unmatched close — leave raw (phase 2 → markup)
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
        openStack.push(tagKey);
        return `<${tagKey}>`;
      }
    );

    // Phase 2: Mask variables (comments, non-allowed tags, ignoreWords, dates, numbers).
    // We skip the interior of normalized tag markers to avoid matching their index digits.
    const variables: VariableInfo[] = [];
    // Built from slices rather than char-by-char: `chunkStart` marks the start of
    // the run of literal text not yet flushed into `parts`.
    const parts: string[] = [];
    let chunkStart = 0;
    // The next variable match at or after the scan head. The regex is scanned
    // forward lazily and its result cached: re-running exec() at every character
    // position makes masking quadratic in the input length (each failed probe
    // rescans the rest of the string), which is minutes of CPU on a long page.
    // Recomputed only when we consume a match or jump the head past a stale one.
    this.variableRegex.lastIndex = 0;
    let nextMatch = this.variableRegex.exec(tagProcessed);
    const advanceMatch = (from: number): void => {
      this.variableRegex.lastIndex = from;
      nextMatch = this.variableRegex.exec(tagProcessed);
    };
    const flushTo = (end: number): void => {
      if (end > chunkStart) parts.push(tagProcessed.slice(chunkStart, end));
    };

    let i = 0;
    while (i < tagProcessed.length) {
      // An ignored-subtree region (lifted out in phase 0) becomes one opaque
      // variable whose value is the region's verbatim markup, so it round-trips
      // exactly like other masked variables and never makes the string
      // translatable on its own.
      if (tagProcessed[i] === IGNORE_OPEN) {
        const closeIdx = tagProcessed.indexOf(IGNORE_CLOSE, i + 1);
        if (closeIdx !== -1) {
          const k = parseInt(tagProcessed.slice(i + 1, closeIdx), 10);
          flushTo(i);
          parts.push(`{{${variables.length}}}`);
          variables.push({ value: ignoredValues[k] ?? '', type: 'ignored' });
          i = chunkStart = closeIdx + 1;
          continue;
        }
      }

      // Mask HTML comments as variables
      if (tagProcessed.startsWith('<!--', i)) {
        const closeIdx = tagProcessed.indexOf('-->', i + 4);
        if (closeIdx !== -1) {
          flushTo(i);
          parts.push(`{{${variables.length}}}`);
          variables.push({ value: tagProcessed.slice(i, closeIdx + 3), type: 'comment' });
          i = chunkStart = closeIdx + 3;
          continue;
        }
      }

      // Handle a tag: a normalized allowed-tag marker (<span0>, </span0>) is copied
      // verbatim; anything else is a non-allowed tag masked as an opaque markup
      // variable so its (possibly volatile) attributes never enter the cache key.
      if (tagProcessed[i] === '<') {
        const closeIdx = tagProcessed.indexOf('>', i);
        if (closeIdx !== -1) {
          const tagText = tagProcessed.slice(i, closeIdx + 1);
          const markerMatch = /^<\/?([a-zA-Z][\w-]*)>$/.exec(tagText);
          if (markerMatch && tagAttributes.has(markerMatch[1]!)) {
            // Verbatim: leave it in the current literal chunk.
            i = closeIdx + 1;
          } else {
            flushTo(i);
            parts.push(`{{${variables.length}}}`);
            variables.push({ value: tagText, type: 'markup' });
            i = chunkStart = closeIdx + 1;
          }
          continue;
        }
      }

      // A variable match, if one starts exactly here. `nextMatch` is a lookahead
      // that only goes stale when the head jumps a tag/region it pointed into.
      if (nextMatch !== null && nextMatch.index < i) {
        advanceMatch(i);
      }

      if (nextMatch !== null && nextMatch.index === i) {
        flushTo(i);
        parts.push(`{{${variables.length}}}`);
        variables.push(this.buildVariableInfo(nextMatch));
        i = chunkStart = i + nextMatch[0].length;
        advanceMatch(i);
      } else {
        // Literal character — stays in the pending chunk.
        i++;
      }
    }
    flushTo(tagProcessed.length);
    let masked = parts.join('');

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
    locale?: string,
    original?: string,
    ignoredMode: IgnoredMode = 'inline'
  ): string {
    if (translated === '') {
      return '';
    }

    // Phase 1: Detect format and restore variables. Markup variables (the page's
    // own non-allowed tags, captured at mask time) are held as sentinels through
    // sanitization and restored verbatim last, so sanitizeTags never escapes them
    // while still escaping any tags the translation itself introduced.
    const format = this.detectFormat(translated);
    const markupSentinels: [string, string][] = [];
    const ignoredSeq = this.buildIgnoredSeq(variables);

    let result: string;

    if (format === 'icu' && locale) {
      try {
        result = this.evaluateICU(translated, variables, locale, markupSentinels, ignoredMode, ignoredSeq);
      } catch {
        if (original !== undefined) {
          // Fall back to the untranslated source text. It needs no tag
          // restoration or sanitizing, but is stripped of any aggregation
          // sentinels and trimmed so callers can re-apply the edge whitespace
          // they extracted at mask time.
          return stripIgnoreSentinels(original).replace(/^\s+/, '').replace(/\s+$/, '');
        }
        // No original available — fall back to the raw pattern
        result = translated;
      }
    } else {
      // Simple substitution
      const isolate = locale !== undefined && getLocaleDirection(locale) === 'rtl';
      result = translated.replace(/\{\{(\d+)\}\}/g, (_match, indexStr: string) => {
        const idx = parseInt(indexStr, 10);
        const variable = variables[idx];
        if (variable === undefined) return `{{${indexStr}}}`;
        if (variable.type === 'ignored') return this.ignoredSubstitution(variable, idx, ignoredMode, ignoredSeq, markupSentinels);
        if (variable.type === 'markup') return this.markupSentinel(variable.value, markupSentinels);
        return isolate && BIDI_ISOLATED_TYPES.has(variable.type)
          ? FSI + variable.value + PDI
          : variable.value;
      });
    }

    // Phase 2: Restore tag attributes
    result = this.restoreTagAttributes(result, tagAttributes);

    // Phase 3: Sanitize — escape any HTML tags not in the allowlist
    result = this.sanitizeTags(result);

    // Phase 4: Restore markup variables verbatim (they bypass sanitization)
    result = this.restoreMarkup(result, markupSentinels);

    return result;
  }

  /** Records a markup value under a sanitize-proof sentinel and returns the sentinel. */
  private markupSentinel(value: string, out: [string, string][]): string {
    const sentinel = `�MK${out.length}�`;
    out.push([sentinel, value]);
    return sentinel;
  }

  private restoreMarkup(text: string, sentinels: [string, string][]): string {
    let result = text;
    for (const [sentinel, value] of sentinels) {
      result = result.split(sentinel).join(value);
    }
    return result;
  }

  /** Maps each ignored variable's index to its 0-based order among ignored variables. */
  private buildIgnoredSeq(variables: VariableInfo[]): Map<number, number> {
    const seq = new Map<number, number>();
    let k = 0;
    for (let i = 0; i < variables.length; i++) {
      if (variables[i]!.type === 'ignored') seq.set(i, k++);
    }
    return seq;
  }

  /**
   * Substitution for an ignored-subtree variable. In `inline` mode it restores
   * the region's verbatim markup (sanitize-proof, like a markup variable). In
   * `placeholder` mode it emits a throwaway `<i18n-ignored data-k>` element the
   * Translator swaps for the live ignored DOM node.
   */
  private ignoredSubstitution(
    variable: VariableInfo,
    varIndex: number,
    mode: IgnoredMode,
    seq: Map<number, number>,
    out: [string, string][]
  ): string {
    if (mode === 'placeholder') {
      const k = seq.get(varIndex) ?? 0;
      return this.markupSentinel(`<${IGNORED_PLACEHOLDER_TAG} data-k="${k}"></${IGNORED_PLACEHOLDER_TAG}>`, out);
    }
    return this.markupSentinel(variable.value, out);
  }

  /**
   * Dry-runs a translation string exactly as consumption would: detects the
   * format ({{N}} simple, {N ICU, or plain), evaluates it against the given
   * variables, and reports the rendered output or the failure reason.
   */
  validateIcu(
    translated: string,
    variables: VariableInfo[],
    locale: string,
    tagAttributes?: Map<string, Record<string, string>>
  ): IcuValidationResult {
    const format = this.detectFormat(translated);
    const markupSentinels: [string, string][] = [];
    const ignoredSeq = this.buildIgnoredSeq(variables);

    let output: string;
    if (format === 'icu') {
      try {
        output = this.evaluateICU(translated, variables, locale, markupSentinels, 'inline', ignoredSeq);
      } catch (err) {
        return { valid: false, format, error: err instanceof Error ? err.message : String(err) };
      }
    } else if (format === 'simple') {
      const missing = new Set<string>();
      const isolate = getLocaleDirection(locale) === 'rtl';
      output = translated.replace(/\{\{(\d+)\}\}/g, (match, indexStr: string) => {
        const idx = parseInt(indexStr, 10);
        const variable = variables[idx];
        if (variable === undefined) {
          missing.add(match);
          return match;
        }
        if (variable.type === 'ignored') return this.ignoredSubstitution(variable, idx, 'inline', ignoredSeq, markupSentinels);
        if (variable.type === 'markup') return this.markupSentinel(variable.value, markupSentinels);
        return isolate && BIDI_ISOLATED_TYPES.has(variable.type)
          ? FSI + variable.value + PDI
          : variable.value;
      });
      if (missing.size > 0) {
        return {
          valid: false,
          format,
          error: `substitution references ${[...missing].join(', ')} but only ${variables.length} variable(s) were provided`,
        };
      }
    } else {
      output = translated;
    }

    if (tagAttributes) {
      output = this.restoreTagAttributes(output, tagAttributes);
    }
    output = this.sanitizeTags(output);
    output = this.restoreMarkup(output, markupSentinels);

    return { valid: true, format, output };
  }

  /**
   * Masks `original` to derive the variables and tag attributes consumption
   * would see, then validates `translated` against them — including the case
   * pattern and edge whitespace the rendered output would carry.
   */
  validateTranslation(original: string, translated: string, locale: string): IcuValidationResult {
    const maskResult = this.mask(original);
    const result = this.validateIcu(translated, maskResult.variables, locale, maskResult.tagAttributes);
    if (!result.valid || result.output === undefined) {
      return result;
    }
    const output = maskResult.leadingWhitespace
      + this.applyCasePattern(result.output, maskResult.casePattern)
      + maskResult.trailingWhitespace;
    return { ...result, output };
  }

  /**
   * How a translation string will be consumed: {{N}} = simple substitution
   * (our format), {N} or {N, plural/select, ...} = ICU, otherwise plain text.
   * Single source of truth for both unmask() and validateIcu().
   */
  private detectFormat(translated: string): TranslationFormat {
    if (/\{\{\d+\}\}/.test(translated)) return 'simple';
    if (/\{\d+/.test(translated)) return 'icu';
    return 'plain';
  }

  /** Replaces <tagN> with <tag attrs...> and </tagN> with </tag>. */
  private restoreTagAttributes(
    text: string,
    tagAttributes: Map<string, Record<string, string>>
  ): string {
    let result = text.replace(
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

  /**
   * Constructs the message format, degrading the locale stepwise when Intl
   * rejects it as ill-formed BCP 47 (a RangeError): first the primary language
   * subtag ('es-41' → 'es'), then the universal 'und' tag. This mirrors ICU4C's
   * lenient locale fallback in the PHP port, so a bad locale never causes the
   * translation itself to be dropped. Note 'und' resolves to the runtime's
   * default locale, not ICU's root — the terminal step's exact plural rules
   * are the one place the two ports may differ.
   */
  private buildMessageFormat(icuPattern: string, locale: string): IntlMessageFormat {
    try {
      return new IntlMessageFormat(icuPattern, locale);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err; // not a locale problem
      const language = locale.split(/[-_]/)[0];
      if (language && language !== locale) {
        try {
          return new IntlMessageFormat(icuPattern, language);
        } catch (err2) {
          if (!(err2 instanceof RangeError)) throw err2;
        }
      }
      return new IntlMessageFormat(icuPattern, 'und');
    }
  }

  private evaluateICU(
    pattern: string,
    variables: VariableInfo[],
    locale: string,
    markupOut?: [string, string][],
    ignoredMode: IgnoredMode = 'inline',
    ignoredSeq?: Map<number, number>
  ): string {
    // Temporarily replace all HTML tags to prevent ICU parser conflicts
    const tagPlaceholders: [string, string][] = [];
    const icuPattern = pattern.replace(/<\/?[^>]+>/g, (match) => {
      const placeholder = `\uFFFD${tagPlaceholders.length}\uFFFD`;
      tagPlaceholders.push([placeholder, match]);
      return placeholder;
    });

    const mf = this.buildMessageFormat(icuPattern, locale);
    const args: Record<string, string | number> = {};

    for (let i = 0; i < variables.length; i++) {
      const vi = variables[i]!;
      // Parse numbers for proper ICU plural rule evaluation
      if (vi.type === 'ignored' && markupOut) {
        args[String(i)] = this.ignoredSubstitution(vi, i, ignoredMode, ignoredSeq ?? this.buildIgnoredSeq(variables), markupOut);
      } else if (vi.type === 'markup' && markupOut) {
        // Hold markup behind a sanitize-proof sentinel; restored verbatim by the caller.
        args[String(i)] = this.markupSentinel(vi.value, markupOut);
      } else if (vi.type === 'number') {
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
