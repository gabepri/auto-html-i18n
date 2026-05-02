import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Masker } from '../src/Masker';
import type { CasePattern, IgnoreWordEntry, MaskerConfig, VariableInfo } from '../src/types';

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

const DEFAULT_ALLOWED_TAGS = ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del'];

// Vitest runs from the package directory (packages/js); fixtures live at the repo root.
const fixturesDir = resolve(process.cwd(), '../../fixtures/masker');

function loadFixtures(): Array<{ file: string; cases: FixtureCase[] }> {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const cases = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as FixtureCase[];
      return { file, cases };
    });
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
