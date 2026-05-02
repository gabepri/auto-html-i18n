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

This monorepo is the source of truth for both packages. There's also a read-only mirror at [`gabepri/auto-html-i18n-php`](https://github.com/gabepri/auto-html-i18n-php) that contains only `packages/php/` at the repo root — it exists because Packagist requires `composer.json` at the root of a repo and doesn't support monorepo subdirectories. The mirror is auto-rebuilt on every push to `main` and on every `v*` tag by [.github/workflows/split-php.yml](.github/workflows/split-php.yml). **Don't push to the mirror directly** — it'll be overwritten on the next split.

## Releasing

Each package versions independently.

### JS (npm)

```bash
cd packages/js
npm version <patch|minor|major>           # bumps package.json + package-lock.json
cd ../..
VER=$(node -p "require('./packages/js/package.json').version")
git add packages/js/package.json packages/js/package-lock.json
git commit -m "$VER"
git tag "v$VER"
git push origin main "v$VER"
gh release create "v$VER" --generate-notes
```

In a monorepo, `npm version` only bumps the file — it doesn't auto-commit/tag, so the steps above do that explicitly. The release-creation event triggers [.github/workflows/publish.yml](.github/workflows/publish.yml), which publishes to npm via OIDC trusted publishing (no token in repo). First-time publishing of a new package name requires `--access public` in the workflow and a trusted-publisher entry on npmjs.com.

### PHP (Composer / Packagist)

```bash
git tag v1.0.1 && git push origin v1.0.1
```

That's it. The split workflow mirrors `packages/php/` to `auto-html-i18n-php` with the new tag, and Packagist's webhook on the mirror auto-syncs within a minute.

The split uses an SSH deploy key — public key on the mirror repo, private key as the `PHP_SPLIT_DEPLOY_KEY` secret on this repo. Rotate by regenerating the keypair (`ssh-keygen -t ed25519`) and updating both sides.

## License

MIT — see [LICENSE](LICENSE).
