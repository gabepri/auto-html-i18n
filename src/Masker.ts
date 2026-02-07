import type { MaskerConfig, MaskResult } from './types';

export class Masker {
  private ignoreWords: string[];
  private allowedInlineTags: Set<string>;
  private variableRegex: RegExp;

  constructor(config: MaskerConfig) {
    // Sort ignoreWords longest-first for greedy matching
    this.ignoreWords = [...config.ignoreWords].sort((a, b) => b.length - a.length);
    this.allowedInlineTags = new Set(config.allowedInlineTags);
    this.variableRegex = this.buildVariableRegex();
  }

  mask(text: string): MaskResult {
    if (text === '') {
      return { masked: '', variables: [], tagAttributes: new Map() };
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
    const variables: string[] = [];
    let masked = '';
    let i = 0;
    while (i < tagProcessed.length) {
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
        variables.push(match[0]);
        masked += `{{${index}}}`;
        i += match[0].length;
      } else {
        // Copy character and advance
        masked += tagProcessed[i];
        i++;
      }
    }

    return { masked, variables, tagAttributes };
  }

  unmask(
    translated: string,
    variables: string[],
    tagAttributes: Map<string, Record<string, string>>
  ): string {
    if (translated === '') {
      return '';
    }

    // Phase 1: Restore variables
    let result = translated.replace(/\{\{(\d+)\}\}/g, (_match, indexStr: string) => {
      const index = parseInt(indexStr, 10);
      return variables[index] ?? `{{${indexStr}}}`;
    });

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
    const parts: string[] = [];

    // 1. IgnoreWords (longest first, word boundaries)
    for (const word of this.ignoreWords) {
      parts.push(escapeRegex(word));
    }

    // 2. Date patterns (must come before number patterns)
    // Matches: MM/DD/YYYY, YYYY-MM-DD, DD.MM.YYYY, etc.
    parts.push('\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4}');

    // 3. Numbers (including negative and decimals)
    parts.push('-?\\d+(?:\\.\\d+)?');

    if (parts.length === 0) {
      return /(?!)/; // Never matches
    }

    return new RegExp(parts.join('|'), 'g');
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
