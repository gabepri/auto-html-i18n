import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Masker } from '../src/Masker';
import { getLocaleDirection } from '../src/direction';
import type { CasePattern, IgnoreWordEntry, MaskerConfig, TextDirection, VariableInfo } from '../src/types';

interface FixtureCase {
  name: string;
  input: string;
  config?: {
    ignoreWords?: IgnoreWordEntry[];
    allowedInlineTags?: string[];
  };
  expected: {
    masked: string;
    variables: VariableInfo[];
    tagAttributes?: Record<string, Record<string, string>>;
    casePattern?: CasePattern;
    leadingWhitespace?: string;
    trailingWhitespace?: string;
  };
}

interface UnmaskFixtureCase {
  name: string;
  translated: string;
  variables?: VariableInfo[];
  tagAttributes?: Record<string, Record<string, string>>;
  locale?: string;
  original?: string;
  config?: FixtureCase['config'];
  expected: string;
}

interface ValidateFixtureCase {
  name: string;
  translated: string;
  variables?: VariableInfo[];
  locale: string;
  config?: FixtureCase['config'];
  expected: {
    valid: boolean;
    format: 'icu' | 'simple' | 'plain';
    output?: string;
  };
}

interface DirectionFixtureCase {
  name: string;
  locale: string;
  expected: TextDirection;
}

const DEFAULT_ALLOWED_TAGS = ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del'];

// Vitest runs from the package directory (packages/js); fixtures live at the repo root.
const fixturesDir = resolve(process.cwd(), '../../fixtures/masker');
const unmaskFixturesDir = resolve(process.cwd(), '../../fixtures/unmask');
const validateFixturesDir = resolve(process.cwd(), '../../fixtures/icu-validate');
const directionFixturesDir = resolve(process.cwd(), '../../fixtures/direction');

function loadFixtureDir<T>(dir: string): Array<{ file: string; cases: T[] }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const cases = JSON.parse(readFileSync(join(dir, file), 'utf8')) as T[];
      return { file, cases };
    });
}

function loadFixtures(): Array<{ file: string; cases: FixtureCase[] }> {
  return loadFixtureDir<FixtureCase>(fixturesDir);
}

function buildConfig(cfg: FixtureCase['config']): MaskerConfig {
  return {
    ignoreWords: cfg?.ignoreWords ?? [],
    allowedInlineTags: cfg?.allowedInlineTags ?? DEFAULT_ALLOWED_TAGS,
  };
}

describe('shared masker fixtures', () => {
  for (const { file, cases } of loadFixtures()) {
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          const masker = new Masker(buildConfig(c.config));
          const result = masker.mask(c.input);

          expect(result.masked).toBe(c.expected.masked);
          expect(result.variables).toEqual(c.expected.variables);

          const expectedTagAttrs = c.expected.tagAttributes ?? {};
          const actualTagAttrs = Object.fromEntries(result.tagAttributes.entries());
          expect(actualTagAttrs).toEqual(expectedTagAttrs);

          expect(result.casePattern).toBe(c.expected.casePattern ?? 'lower');
          expect(result.leadingWhitespace).toBe(c.expected.leadingWhitespace ?? '');
          expect(result.trailingWhitespace).toBe(c.expected.trailingWhitespace ?? '');
        });
      }
    });
  }
});

describe('shared unmask fixtures', () => {
  for (const { file, cases } of loadFixtureDir<UnmaskFixtureCase>(unmaskFixturesDir)) {
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          const masker = new Masker(buildConfig(c.config));
          const tagAttributes = new Map(Object.entries(c.tagAttributes ?? {}));

          const result = masker.unmask(
            c.translated,
            c.variables ?? [],
            tagAttributes,
            c.locale,
            c.original
          );

          expect(result).toBe(c.expected);
        });
      }
    });
  }
});

describe('shared direction fixtures', () => {
  for (const { file, cases } of loadFixtureDir<DirectionFixtureCase>(directionFixturesDir)) {
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          expect(getLocaleDirection(c.locale)).toBe(c.expected);
        });
      }
    });
  }
});

describe('shared ICU validation fixtures', () => {
  for (const { file, cases } of loadFixtureDir<ValidateFixtureCase>(validateFixturesDir)) {
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          const masker = new Masker(buildConfig(c.config));

          const result = masker.validateIcu(c.translated, c.variables ?? [], c.locale);

          expect(result.valid).toBe(c.expected.valid);
          expect(result.format).toBe(c.expected.format);
          if (c.expected.output !== undefined) {
            expect(result.output).toBe(c.expected.output);
          }
          if (!c.expected.valid) {
            // Error text is engine-specific; only its presence is part of the contract
            expect(result.error).toBeTruthy();
          }
        });
      }
    });
  }
});
