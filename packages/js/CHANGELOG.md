# Changelog

## Unreleased

### List-valued options extend the defaults instead of replacing them

A plain array passed to any list-valued option is now **unioned** with the library defaults, deduplicated. Previously it replaced them, so adding one selector silently dropped `script`/`style`/`code` and froze you out of every default added later.

```js
new I18nObserver({ ignoreSelectors: ['.mine'] });        // defaults + '.mine'
new I18nObserver({ ignoreSelectors: () => ['.mine'] });  // exactly ['.mine'] — used verbatim
```

The function form receives the defaults and its return value is used verbatim, so it also covers "all the defaults except one": `(defaults) => defaults.filter((s) => s !== 'code')`.

This applies uniformly to **every** list-valued option — `allowedInlineTags`, `translatableAttributes`, `ignoreSelectors`, `ignoreWords`, `translatorSignals` — and to every list option added in future; there are deliberately no `extra*`/`inherit*` variants and no per-option merge flags. Strings dedupe by value; object entries dedupe by their identifying field (`id` for translator signals, `word` for ignore words) with the consumer's entry winning.

### Added

- Every default list is exported as a named constant: `DEFAULT_IGNORE_SELECTORS`, `DEFAULT_ALLOWED_INLINE_TAGS`, `DEFAULT_TRANSLATABLE_ATTRIBUTES`, `DEFAULT_IGNORE_WORDS` (`EXTERNAL_TRANSLATOR_SIGNALS` already was), plus the `ListOption<T>` type.
- `DEFAULT_IGNORE_SELECTORS` now also covers browser-extension UI containers: `com-1password-button`, `com-1password-menu`, `com-1password-notification`, `[id^="__lpform"]`, `grammarly-extension`, `grammarly-desktop-integration`. Extension UI is localized to the *user's* language and is never site copy — it was being collected and reported as missing source text (a Japanese 1Password autofill hint reported as a "missing English string" is the case that prompted this). The list will keep growing, which the inherit-by-default behavior above makes a non-event.

### Renamed

- `extraTranslatorSignals` → `translatorSignals`, folded into the convention above (a plain array behaves as `extraTranslatorSignals` did, now deduplicated by `id`).
