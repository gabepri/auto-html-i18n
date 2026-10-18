# Changelog

## 1.3.4

### Changed

- **Requires Node 20 or later** (`engines.node` `>=18` → `>=20`). Node 18 reached end of life in April 2025, and CI now tests on Node 20, 22 and 24. The library itself runs in the browser, so this only affects the Node version used to install and build it.

### Fixed

- **`ignoreWords` are masked only as whole words.** An ignore word used to be masked inside any longer word that contained it. With the surname `Ma` configured, `May I help, Ma?` masked to `{{0}}y I help, {{1}}?` and `Manage` to `{{0}}nage`; the product name `Mi Fit` turned `Mi Fitness` into `{{0}}ness`. Translators were handed fragments like `{{0}}y I help`, which machine-translated into garbage, and for a person's name the key was one only that user produced, so the string missed the cache, rendered untranslated and was reported as new missing source. A match must now start and end at a word boundary, where letters, combining marks and digits in any script continue a word. If a longer ignore word would split a word, a shorter one that fits still matches. An edge that isn't a word character needs no boundary (`CA$` still matches in `CA$500`, and `IncentFit's` still masks the name), and neither do scripts written without spaces (`田中` still matches in `田中様`, and `IncentFit` in `IncentFitのアプリ`). A suffix attached with no apostrophe now counts as part of the word, so the name stays in the text: `the Smiths`, German `Marias`, Korean `민수가`. The PHP port gets the same fix.

  **No cache migration is needed.** Only keys where an ignore word matched inside another word change. For a word only some users have configured, typically a person's name, the corrected key is the one everyone else already produces, so existing translations apply. For a word every user has, typically a brand (`IncentFit` in `IncentFitness`), the corrected key is new and is reported once, like any new string. Rows under the old keys (`{{0}}y I help`, `{{0}}nage`, …) are never looked up again and can be deleted from your translation store.

## 1.3.3

### Fixed

- **A framework patch to part of a translated sentence no longer reports our own translation as missing source.** A sentence with inline tags is translated as one unit, but a framework (Vue patching `{{ binding }}` in `Last chat: <b>{{ title }}</b> · {{ ago }}`) rewrites only the nodes it bound, leaving the translation in the rest. That half-translated string was reported through `onMissingTranslation` (e.g. `前回のチャット: {{0}} · a few seconds ago`), where it became a junk row, while the real new source was never looked up, so the sentence stayed half translated until reload. The library now puts the original text back into the nodes the framework didn't touch, in source order even when the translation reordered them, and handles the sentence exactly as a fresh render of the new source: a cached translation is applied in place (same nodes), otherwise the source shows while it's reported.
- **Patching only a number in a translated sentence no longer leaves a stale original behind.** `<b>3</b> of <b>5</b> weeks` → `<b>4</b>…` masks to the same key, so nothing was reported, but `data-i18n-original` kept `3`, and a later locale switch or `stop(true)` brought `3` back.
- **`stop(true)` reverts a sentence a framework patched part of.** It used to leave the whole sentence translated when the patch hadn't been observed yet; now the patched nodes keep their new text and the rest is reverted.

## 1.3.0

### List-valued options extend the defaults instead of replacing them

A plain array passed to any list-valued option is now **unioned** with the library defaults, deduplicated. Previously it replaced them, so adding one selector silently dropped `script`/`style`/`code` and froze you out of every default added later.

> **Upgrading with a narrowed `allowedInlineTags`? Read this.** That option feeds the cache key: a tag *in* the list masks to an inline marker (`<b0>text</b0>`), a tag *outside* it masks to an opaque variable (`{{0}}text{{1}}`). Because a plain array now inherits the defaults, any tag you previously excluded by omission becomes allowed — which **changes the cache key for affected content and misses your existing translations**, re-reporting them through `onMissingTranslation`. To keep v1.2.x keys exactly, switch to the function form, which is used verbatim:
>
> ```js
> new I18nObserver({ allowedInlineTags: () => ['b', 'i'] }); // exactly these, as before
> ```
>
> The other list options (`ignoreSelectors`, `translatableAttributes`, `ignoreWords`, `translatorSignals`) do not affect cache keys and need no action.

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
