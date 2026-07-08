# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

This is a monorepo with one library implemented across multiple runtimes:

- [packages/js](packages/js/) — TypeScript browser library (the original `auto-html-i18n` npm package)
- [packages/php](packages/php/) — PHP 8.1+ server-side library
- [fixtures/](fixtures/) — shared JSON test cases (Masker behavior parity across ports)

When working on a package, `cd` into it first; commands below are scoped to the relevant package directory.

## Commands

### JS package — run from `packages/js/`

```bash
npm run build          # TypeScript typecheck + Vite build (outputs dist/)
npm run test           # Run tests once (Vitest + happy-dom)
npm run test:watch     # Watch mode
npm run test:coverage  # Tests with coverage (80% threshold: branches/functions/lines/statements)
npm run lint           # ESLint
npm run lint:fix       # ESLint auto-fix
npm run typecheck      # TypeScript strict type checking
```

### PHP package — run from `packages/php/`

```bash
composer install              # Install dependencies
vendor/bin/phpunit            # Run the test suite
vendor/bin/phpunit --coverage-text  # With coverage (requires xdebug or pcov)
```

CI runs both packages in parallel: JS on Node 18/20/22, PHP on 8.1/8.2/8.3.

## Architecture

Both ports share the same conceptual pipeline: **walk markup → mask text → resolve variants → translate → restore variables → write back**.

### JS package (browser)

Live, mutation-driven via `MutationObserver`:

- **I18nObserver** — Main facade. Wires modules together, manages lifecycle and config.
- **Observer** — MutationObserver + TreeWalker. Collects text nodes and translatable attributes and forwards them all; the Translator decides what to skip. Uses a WeakSet only to dedupe aggregation targets within a walk. Aggregates an element's innerHTML into one unit only when its **entire descendant subtree** is inline-allowed **and it has direct interleaved text of its own** — a non-inline element anywhere below (e.g. an `<input>`/`<svg>` nested in a `<span>`) disqualifies aggregation, and a pure container of inline elements with no direct text (a nav menu, link list, or button group) is treated as structural too, so each child is translated independently and keeps its own DOM node and cache key. Structural wrappers aren't mistaken for formatted sentences (`hasInlineChildElements`/`isFullyInline`/`hasDirectTextContent`, mirrored in the PHP `HtmlWalker`). An **ignored descendant** (`ignoreAttribute`/`ignoreSelectors`) of an aggregation target that is not itself ignored is NOT folded into the unit: `serializeAggregate` (in `ignore.ts`) brackets each topmost ignored subtree in PUA sentinels (`IGNORE_OPEN/CLOSE`) so its user-data text never enters the cache key — a distinct concern from the collection/flush-time `isInsideIgnored` guard, which skips nodes whose *ancestor* is ignored. This is JS-only.
- **Translator** — Coordinates cache lookup → masking → resolution → DOM update. Tracks pending nodes by cache key (multiple nodes can share one key, resolved atomically). Remembers last-applied output per element/attribute (WeakMaps) to skip its own mutation echoes, re-translate framework-patched content, and keep stale pending applies, `retranslateAll`, and `revertAll` from clobbering newer content. Applies aggregated inline units (`isHtml`) by **morphing** rather than `innerHTML =`: it reuses the original child element nodes (matched to their masked `<tagN>` marker via `morphInto`/`buildMarkerToNode`, order tracked in a `nodeMarkers` WeakMap) and grafts the translated content into them, so interactive descendants keep their event listeners / framework (e.g. router-link) bindings; it falls back to a plain `innerHTML` write when markers can't be matched 1:1 (ICU branch selection or tags the translation added/dropped). JS-only — the PHP port re-serializes and has no listeners to preserve. Ignored subtrees inside an aggregated unit are masked as opaque `ignored` variables; on apply the Translator preserves their **live DOM node** in place (`restoreIgnoredNodes`/`collectTopLevelIgnored`, via an `<i18n-ignored>` placeholder), and `buildMarkerToNode` skips them so inline-marker numbering stays aligned. Because the bracketed serialization is the canonical form (stored in `data-i18n-original`, re-masked on retranslate), all `isHtml` content comparisons go through the injected `serializeAggregate`, and `revertAll`/reported `original` strip the sentinels.
- **Store** — Two-tier Map (`locale → key → StoreEntry`). Entries have status: `pending | resolved | reported`. Won't overwrite resolved with pending.
- **Queue** — Debounces (200ms default) and batches (50/request). Deduplicates on masked key. Chunks large batches sequentially.
- **Masker** — Normalizes text to cache keys. Masks numbers, dates (MM/DD/YYYY, YYYY-MM-DD, DD.MM.YYYY), ignoreWords (sorted longest-first for greedy matching), and inline HTML tags. Strips tag attributes in key (e.g. `<a href="/x">click</a>` → `<a0>click</a0>`), re-injects after translation; closing tags are matched to their opener by a stack so nested same-name tags don't cross-index. Tags **not** in `allowedInlineTags` are masked as opaque `markup` variables (attributes and all) so their volatile bits never enter the key; a *phase 0* also lifts `IGNORE_OPEN`…`IGNORE_CLOSE`-bracketed ignored subtrees (from the Observer's `serializeAggregate`) into opaque `ignored` variables before any tag masking. On `unmask()` both round-trip verbatim via a sanitize-proof sentinel (restored after `sanitizeTags`, so source markup is preserved while translation-introduced tags are still escaped). `unmask()` evaluates ICU patterns; on ICU failure it falls back to the caller-provided original source text (raw pattern only when no original is given). `validateIcu()`/`validateTranslation()` (also on both facades) expose the same evaluation as a dry-run returning `{valid, format, error?, output?}`.
- **Resolver** — Generates compound variant candidates from context (e.g. `female_formal` → `female` → fallback). Respects `contextOrder`.

Failed translations are marked `reported` to prevent infinite re-queuing.

### PHP package (server)

Single-pass synchronous transform — HTML string in, translated HTML string out. Same Masker/Store/Resolver concepts; no observer, queue, or async pending state. The walker uses `Masterminds/html5-php` to parse, walk, mutate, and re-serialize in one pass per `translateHtml()` call. `onMissingTranslation` is called once with the full batch of unknown keys at the end of the walk.

## Shared fixtures

Behavior-critical Masker test cases live in [fixtures/masker/](fixtures/masker/) (masking — including `nested-tags.json` for stack-matched closers and `non-allowed-tags.json` for opaque `markup` masking), [fixtures/unmask/](fixtures/unmask/) (unmasking/ICU fallback/RTL bidi isolation/`markup-roundtrip.json`), [fixtures/icu-validate/](fixtures/icu-validate/) (validation verdicts), and [fixtures/direction/](fixtures/direction/) (locale → writing direction) as JSON. Both packages have a fixture-driven test suite that loads these and asserts the local Masker reproduces them. Adding a fixture exercises both ports automatically — this is the cross-port regression net.

Don't fixture behavior that hinges on the ICU engines' terminal locale fallback: for a wholly invalid locale, PHP ends at ICU's root locale while JS's `und` resolves to the runtime default, so plural categories can differ there (the `other` branch is safe to fixture; `one` is not). Those cases belong in port-specific tests.

## Development Workflow

**Always use test-driven development (TDD):**
1. Write or update tests first to define expected behavior
2. Run tests to confirm they fail
3. Implement the change
4. Run tests to confirm they pass
5. Before considering work complete, run the full test/lint/typecheck suite for the package you touched.

Tests live in `tests/` within each package. Coverage excludes barrel/type files (`src/index.ts`, `src/types.ts` in JS).

When changing Masker behavior, prefer adding a shared fixture (so both ports stay in sync) over a JS-only or PHP-only test.

## Documentation

Update the relevant package README whenever the public API or config changes, or when documentation becomes ambiguous or untrue.

## Releasing

See the [Releasing section in the root README](README.md#releasing) for the per-package recipes. Two non-obvious things:

- `npm version` in `packages/js/` only bumps files in a monorepo — it doesn't auto-commit/tag. The README recipe handles this explicitly.
- The PHP package publishes via a read-only mirror at `gabepri/auto-html-i18n-php` because Packagist requires `composer.json` at the repo root. The mirror is auto-rebuilt by [.github/workflows/split-php.yml](.github/workflows/split-php.yml) using an SSH deploy key (secret name `PHP_SPLIT_DEPLOY_KEY`). Never push to the mirror directly — always edit `packages/php/` here.

## Git Conventions

- Keep commit messages very short (under 100 chars preferred)
- Do not mention Claude or AI in commit messages
- Do not include `Co-Authored-By` lines
