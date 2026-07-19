import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { I18nObserver } from '../src/I18nObserver';
import { Masker } from '../src/Masker';
import type { TranslationItem } from '../src/types';

/**
 * Performance budgets.
 *
 * These assert on *operation counts*, not milliseconds. A wall-clock threshold on a
 * shared CI runner flakes, gets grudgingly loosened, and stops protecting anything;
 * a count of "how many times did masking a paragraph scan for a variable" is
 * deterministic and fails the moment an algorithmic regression lands. Each budget below
 * corresponds to a real regression that shipped.
 *
 * When one of these fails, the fix is to make the code do less work — not to raise the
 * number. Raise it only deliberately, with a reason.
 */

const ALLOWED_INLINE_TAGS = ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del'];
// Function form: used verbatim, so the budget below is measured against exactly these
// five selectors and doesn't drift as DEFAULT_IGNORE_SELECTORS grows.
const IGNORE_SELECTORS = ['.no-i18n', '[data-skip]', 'code', 'script', 'style'];
const ONLY_IGNORE_SELECTORS = () => IGNORE_SELECTORS;

function makeMasker(): Masker {
  return new Masker({ ignoreWords: ['Acme', 'Widget Pro'], allowedInlineTags: ALLOWED_INLINE_TAGS });
}

/**
 * Counts scans of the Masker's *variable* regex while `fn` runs, ignoring every other
 * regex in the process. Spying on RegExp.prototype.exec alone would also count each
 * global String.replace's internal iteration (detectCasePattern strips non-letters one
 * match at a time), which scales with input length and would drown out the signal. The
 * variable regex is the one that was being re-probed per character; it's identifiable by
 * the ignoreWord alternation compiled into it.
 */
function countVariableScans(fn: () => void): number {
  const realExec = RegExp.prototype.exec;
  let scans = 0;
  const spy = vi
    .spyOn(RegExp.prototype, 'exec')
    .mockImplementation(function (this: RegExp, input: string) {
      if (this.source.includes('Acme')) scans++;
      return realExec.call(this, input) as RegExpExecArray | null;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return scans;
}

/** A realistic app page: rows of nested containers holding sentences, links and inputs. */
function buildPage(root: HTMLElement, rows: number, depth: number): void {
  let html = '';
  for (let r = 0; r < rows; r++) {
    let inner =
      `<p>Row ${r} contains <strong>bold text</strong> and a <a href="/r/${r}">link</a> inline.</p>` +
      `<span>Standalone label ${r}</span>` +
      `<button title="Open row ${r}">Open</button>` +
      `<input placeholder="Search rows" />`;
    for (let d = 0; d < depth; d++) inner = `<div class="lvl-${d}">${inner}</div>`;
    html += inner;
  }
  root.innerHTML = html;
}

/** Translatable units per row of buildPage: the aggregated <p>, the <span>, a title, a placeholder. */
const UNITS_PER_ROW = 4;

describe('performance budgets', () => {
  let root: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Masker', () => {
    // mask() runs on every text node before any cache lookup, making it the hottest path
    // in the library. It once probed the variable regex at every character position,
    // rescanning the rest of the string on each miss: quadratic in input length, and
    // ~35ms of pure CPU to mask one 1.2KB paragraph. Counting those probes catches the
    // whole class of regression directly.
    it('scans for variables a bounded number of times, not once per character', () => {
      const masker = makeMasker();
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(28); // ~1.2KB, no variables

      const scans = countVariableScans(() => masker.mask(text));

      // The text holds no variables, so one scan settles it. Per-character probing puts
      // this in the thousands (one per character, each rescanning the rest of the string).
      expect(scans).toBeLessThanOrEqual(5);
    });

    it('scans grow with the number of variables, not the length of the text', () => {
      const masker = makeMasker();
      // Same variable count (10 numbers), wildly different lengths.
      const short = Array.from({ length: 10 }, (_, i) => `Item ${i}`).join(' ');
      const long = Array.from({ length: 10 }, (_, i) => `Item ${i} ${'padding words here '.repeat(30)}`).join(' ');

      const shortScans = countVariableScans(() => masker.mask(short));
      const longScans = countVariableScans(() => masker.mask(long));

      expect(long.length).toBeGreaterThan(short.length * 20);
      // Roughly one scan per variable either way — the padding must not cost extra scans.
      expect(longScans).toBeLessThanOrEqual(shortScans + 5);
    });

  });

  describe('page scan', () => {
    /** Scans a page, measuring only the initial walk (before any translation is applied). */
    function scanPage(rows: number, depth: number): { i18n: I18nObserver; matchesCalls: number } {
      const i18n = new I18nObserver({
        locale: 'es',
        rootElement: root,
        ignoreSelectors: ONLY_IGNORE_SELECTORS,
        onMissingTranslation: (items) =>
          Promise.resolve(Object.fromEntries(items.map((i) => [i.masked, `ES ${i.masked}`]))),
      });
      buildPage(root, rows, depth);

      const matchesSpy = vi.spyOn(Element.prototype, 'matches');
      i18n.start(); // synchronous walk; translations only land after the debounce flush
      const matchesCalls = matchesSpy.mock.calls.length;
      matchesSpy.mockRestore();

      return { i18n, matchesCalls };
    }

    it('runs each ignoreSelector at most once per element when scanning a page', () => {
      buildPage(root, 25, 6);
      const elementCount = root.querySelectorAll('*').length + 1; // + the walk root
      root.innerHTML = '';

      const { i18n, matchesCalls } = scanPage(25, 6);
      i18n.stop();

      // Testing each element once bounds this at elements × selectors. Re-walking every
      // node's ancestry instead multiplies it by the tree depth.
      expect(matchesCalls).toBeLessThanOrEqual(elementCount * IGNORE_SELECTORS.length);
    });

    it('masks each translatable unit a bounded number of times', async () => {
      const rows = 25;
      const maskSpy = vi.spyOn(Masker.prototype, 'mask');

      const reported: TranslationItem[] = [];
      const i18n = new I18nObserver({
        locale: 'es',
        rootElement: root,
        ignoreSelectors: ONLY_IGNORE_SELECTORS,
        onMissingTranslation: (items) => {
          reported.push(...items);
          return Promise.resolve(Object.fromEntries(items.map((i) => [i.masked, `ES ${i.masked}`])));
        },
      });
      buildPage(root, rows, 6);
      i18n.start();
      vi.advanceTimersByTime(250);
      await vi.runAllTimersAsync();

      const maskCalls = maskSpy.mock.calls.length;
      i18n.stop();

      // Masking collapses the rows' varying numbers into shared keys, so far fewer unique
      // strings are reported than there are units on the page — that dedup is the point.
      expect(reported.length).toBeLessThan(rows * UNITS_PER_ROW);

      // The budget is per *unit*, not per unique key: every unit is masked on the way in,
      // and its applied output normalized once on the way out (the echo guard). More than
      // a small constant per unit means we're re-masking content we already have a key for.
      expect(maskCalls).toBeLessThanOrEqual(rows * UNITS_PER_ROW * 4);
    });

    it('retains no pending nodes once the consumer has declined every string', async () => {
      const i18n = new I18nObserver({
        locale: 'es',
        rootElement: root,
        ignoreSelectors: ONLY_IGNORE_SELECTORS,
        onMissingTranslation: () => Promise.resolve({}),
      });
      buildPage(root, 25, 6);
      i18n.start();
      vi.advanceTimersByTime(250);
      await vi.runAllTimersAsync();

      const pending = (i18n as unknown as { translator: { pendingNodeCount: number } })
        .translator.pendingNodeCount;
      i18n.stop();

      // A declined key can never be applied, so tracking its nodes would pin detached DOM
      // for the life of the page.
      expect(pending).toBe(0);
    });
  });
});
