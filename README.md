# auto-html-i18n

Automatic translation of rendered markup. Walks HTML, extracts translatable text, masks variables (numbers, dates, ignored words, inline tags), looks up translations in a cache, and falls back to a user-supplied backend for misses. ICU MessageFormat is supported throughout.

This repository hosts implementations for multiple runtimes. Both ports share the same masking algorithm and a shared corpus of test fixtures so they stay behaviorally identical.

## Packages

| Package | Runtime | Use it for | Path |
|---|---|---|---|
| `auto-html-i18n` (npm) | Browser / DOM | Live translation of rendered pages via `MutationObserver` | [packages/js](packages/js/) |
| `auto-html-i18n` (Composer) | PHP 8.1+ | Server-side: HTML string in, translated HTML string out | [packages/php](packages/php/) |

## Repo layout

```
packages/
  js/        TypeScript browser library (the original)
  php/       PHP server-side library
fixtures/    Shared JSON test cases (Masker behavior parity)
```

## License

MIT — see [LICENSE](LICENSE).
