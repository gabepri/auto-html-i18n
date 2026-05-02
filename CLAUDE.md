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
- **Observer** — MutationObserver + TreeWalker. Collects text nodes and translatable attributes. Uses WeakSet for re-entry prevention and `data-i18n-original` to skip already-translated nodes.
- **Translator** — Coordinates cache lookup → masking → resolution → DOM update. Tracks pending nodes by cache key (multiple nodes can share one key, resolved atomically).
- **Store** — Two-tier Map (`locale → key → StoreEntry`). Entries have status: `pending | resolved | reported`. Won't overwrite resolved with pending.
- **Queue** — Debounces (200ms default) and batches (50/request). Deduplicates on masked key. Chunks large batches sequentially.
- **Masker** — Normalizes text to cache keys. Masks numbers, dates (MM/DD/YYYY, YYYY-MM-DD, DD.MM.YYYY), ignoreWords (sorted longest-first for greedy matching), and inline HTML tags. Strips tag attributes in key (e.g. `<a href="/x">click</a>` → `<a0>click</a0>`), re-injects after translation.
- **Resolver** — Generates compound variant candidates from context (e.g. `female_formal` → `female` → fallback). Respects `contextOrder`.

Failed translations are marked `reported` to prevent infinite re-queuing.

### PHP package (server)

Single-pass synchronous transform — HTML string in, translated HTML string out. Same Masker/Store/Resolver concepts; no observer, queue, or async pending state. The walker uses `Masterminds/html5-php` to parse, walk, mutate, and re-serialize in one pass per `translateHtml()` call. `onMissingTranslation` is called once with the full batch of unknown keys at the end of the walk.

## Shared fixtures

Behavior-critical Masker test cases live in [fixtures/masker/](fixtures/masker/) as JSON. Both packages have a fixture-driven test suite that loads these and asserts the local Masker reproduces them. Adding a fixture exercises both ports automatically — this is the cross-port regression net.

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

## Git Conventions

- Keep commit messages very short (under 100 chars preferred)
- Do not mention Claude or AI in commit messages
- Do not include `Co-Authored-By` lines
