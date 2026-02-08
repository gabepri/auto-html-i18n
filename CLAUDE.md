# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # TypeScript typecheck + Vite build (outputs dist/)
npm run test           # Run tests once (Vitest + happy-dom)
npm run test:watch     # Watch mode
npm run test:coverage  # Tests with coverage (80% threshold: branches/functions/lines/statements)
npm run lint           # ESLint
npm run lint:fix       # ESLint auto-fix
npm run typecheck      # TypeScript strict type checking
```

CI runs: lint → typecheck → test → build (Node 18, 20, 22).

## Architecture

Pipeline: **observe DOM → mask text → resolve variants → translate → restore variables → apply to DOM**.

- **I18nObserver** — Main facade. Wires modules together, manages lifecycle and config.
- **Observer** — MutationObserver + TreeWalker. Collects text nodes and translatable attributes. Uses WeakSet for re-entry prevention and `data-i18n-original` to skip already-translated nodes.
- **Translator** — Coordinates cache lookup → masking → resolution → DOM update. Tracks pending nodes by cache key (multiple nodes can share one key, resolved atomically).
- **Store** — Two-tier Map (`locale → key → StoreEntry`). Entries have status: `pending | resolved | reported`. Won't overwrite resolved with pending.
- **Queue** — Debounces (200ms default) and batches (50/request). Deduplicates on masked key. Chunks large batches sequentially.
- **Masker** — Normalizes text to cache keys. Masks numbers, dates (MM/DD/YYYY, YYYY-MM-DD, DD.MM.YYYY), ignoreWords (sorted longest-first for greedy matching), and inline HTML tags. Strips tag attributes in key (e.g. `<a href="/x">click</a>` → `<a0>click</a0>`), re-injects after translation.
- **Resolver** — Generates compound variant candidates from context (e.g. `female_formal` → `female` → fallback). Respects `contextOrder`.

Failed translations are marked `reported` to prevent infinite re-queuing.

## Development Workflow

**Always use test-driven development (TDD):**
1. Write or update tests first to define expected behavior
2. Run tests to confirm they fail
3. Implement the change
4. Run tests to confirm they pass
5. Run `npm run test`, `npm run lint`, and `npm run typecheck` before considering work complete

Tests live in `tests/` (8 suites, one per module + integration). Coverage excludes `src/index.ts` and `src/types.ts`.

## Documentation

Consider updating the README whenever necessary.  It should definitely be updated when there are config changes or if anything in the documentation becomes ambiguous or untrue due to the changes being made.

## Git Conventions

- Keep commit messages very short (under 100 chars preferred)
- Do not mention Claude or AI in commit messages
- Do not include `Co-Authored-By` lines
