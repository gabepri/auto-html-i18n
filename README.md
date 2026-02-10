# auto-dom-i18n

[![NPM Version](https://img.shields.io/npm/v/auto-dom-i18n)](https://www.npmjs.com/package/auto-dom-i18n)
[![Build Status](https://img.shields.io/github/actions/workflow/status/gabepri/auto-dom-i18n/main.yml)](https://github.com/gabepri/auto-dom-i18n/actions)
[![License](https://img.shields.io/github/license/gabepri/auto-dom-i18n)](https://github.com/gabepri/auto-dom-i18n/blob/main/LICENSE)

**auto-dom-i18n** is a framework-agnostic translation library that uses `MutationObserver` to automatically translate text content in your application, with built-in ICU MessageFormat support for advanced pluralization and gender handling.

It features **Smart Masking**, **Inline Tag Support**, and **ICU MessageFormat** evaluation. Unlike traditional libraries that map static keys to strings, this library observes the DOM and detects natural language automatically—no manual key mapping or framework bindings required.

## 📋 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Configuration](#️-configuration)
- [Backend Requirements](#-backend-requirements)
- [Programmatic API](#-programmatic-api)
- [How It Works](#-how-it-works)
- [ICU MessageFormat](#-icu-messageformat)
- [Browser Support](#-browser-support)
- [Performance](#-performance)
- [Security](#-security)
- [Debugging](#-debugging)
- [Framework Integration](#-framework-integration)
- [Contributors Guide](#-contributors-guide)
- [License](#-license)

## ✨ Features

* **Automatic Detection:** Uses `MutationObserver` to watch for new DOM elements or text changes.
* **Natural Pluralization:** Handles plurals automatically. "1 item" and "5 items" generate distinct translation keys. For words with identical singular/plural forms (e.g., "sheep"), backends can return ICU MessageFormat strings for proper pluralization in any language.
* **ICU MessageFormat:** Backends can return ICU MessageFormat strings instead of plain translations. The library evaluates `plural`, `select`, and other ICU constructs client-side using variable metadata (type, gender, etc.) auto-detected from the DOM.
* **Smart Masking:** Automatically identifies dynamic content (numbers and symbols, including date formats like `01/15/2024`) and replaces them with placeholders. Proper nouns and other terms can be masked via the `ignoreWords` config. All-uppercase text is normalized to share a cache key with its lowercase equivalent. Casing is restored after translation.
* **Rich Context Hook:** The translation callback receives the original text, masked text, and extracted variables, giving your backend (or LLM) full context.
* **Attribute Preservation:** Automatically strips attributes (like `href`, `class`) from tags before translation and re-injects them.
* **Inline Tag Support:** Intelligently handles HTML tags like `<a>`, `<b>`, or `<span>` as part of the sentence structure.
* **Hybrid Caching:** Instantly replaces text if the translation is known; queues async requests for unknown text.

---

## 📦 Installation

```bash
npm install auto-dom-i18n
# or
yarn add auto-dom-i18n
# or
pnpm add auto-dom-i18n
```

## 🚀 Quick Start

Initialize the library at the root of your application.

```javascript
import { I18nObserver } from 'auto-dom-i18n';

// 1. Define your configuration
const i18n = new I18nObserver({
  locale: 'es', // Target language

  // Words to treat as variables (never translated)
  // Plain strings or objects with metadata for ICU MessageFormat
  ignoreWords: ['Google', { word: 'John Doe', meta: { gender: 'male' } }],

  // THE CALLBACK: Called when text is not in cache
  onMissingTranslation: async (items, locale) => {
    // 'items' contains: [{ masked: "Hello {{0}}", original: "Hello Mary", ... }]

    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, target: locale })
    });
    
    // Return map/object. Can return null to only log/report.
    return await response.json();
  }
});

// 2. Start observing
i18n.start();
```

## ⚙️ Configuration

The `I18nObserver` constructor accepts a config object with the following properties:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `locale` | `string` | **Required** | The target language code (e.g., 'en', 'fr', 'ja'). |
| `onMissingTranslation` | `function` | **Required** | Async function called when text is not in cache. Receives `(items[], locale)`. Return a Map/Object to apply translations, or `null` to take no action. If the callback throws, the affected elements remain in their pending state and the error is logged to the console. |
| `allowedInlineTags` | `string[]` | `['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del']` | HTML tags that are considered part of the sentence structure. |
| `translatableAttributes` | `string[]` | `['title', 'placeholder', 'alt', 'aria-label']` | HTML attributes to translate alongside text nodes. |
| `ignoreSelectors` | `string[]` | `['script', 'style', 'code']` | CSS selectors to ignore. Content inside these elements will never be observed or translated. |
| `ignoreWords` | `IgnoreWordEntry[]` | `[]` | Proper nouns or terms to treat as variables. Each entry can be a plain string (e.g., `'Google'`) or an object with metadata (e.g., `{ word: 'Mary', meta: { gender: 'female' } }`). Metadata is passed to ICU MessageFormat evaluation as `{N_key}` arguments. |
| `initialCache` | `object` | `{}` | A dictionary of pre-loaded translations keyed by masked string (e.g., `{ "Hello {{0}}": "Hola {{0}}" }`). Values can be plain strings or ICU MessageFormat patterns. |
| `rootElement` | `HTMLElement` | `document.body` | The DOM element to observe. Use this to scope translation to a specific subtree. |
| `debounceTime` | `number` | `200` | Time in ms to wait before batching requests. |
| `maxBatchSize` | `number` | `50` | Maximum number of strings per request. |
| `originalAttribute` | `string` | `'data-i18n-original'` | The attribute name used to store the original text on translated elements. |
| `pendingAttribute` | `string` | `'data-i18n-pending'` | The attribute name added to elements while a translation is in-flight. |
| `keyAttribute` | `string` | `'data-i18n-key'` | If this attribute is present on an element, its value is used as the cache key instead of the computed masked string. |
| `ignoreAttribute` | `string` | `'data-i18n-ignore'` | The attribute name that marks an element (and its entire subtree) to be completely skipped by the observer. |
| `debug` | `boolean` | `false` | When enabled, each item in `onMissingTranslation` includes a `debug` field with DOM context for bug reporting. See [Debugging](#-debugging). |

### The `onMissingTranslation` Item Object

The `items` array passed to your callback contains objects with this structure:

```typescript
{
  masked: string;            // "Hello <b0>{{0}}</b0>" (The Cache Key)
  original: string;          // "Hello <b>Mary</b>" (For LLM Context)
  variables: VariableInfo[]; // [{ value: "Mary", type: "ignoreWord", meta: { gender: "female" } }]
  debug?: {                  // Only present when debug: true
    elementOpenTag: string;    // '<p class="greeting">'
    childElements: Array<{ tag: string; classes: string }>;
    source: 'text' | `attribute:${string}`;
  };
}
```

Each variable includes its auto-detected type (`'ignoreWord'`, `'number'`, `'date'`, `'url'`, `'email'`, `'symbol'`, or `'comment'`) and optional metadata from `ignoreWords` config. This information is used for ICU MessageFormat evaluation and can help your backend generate better translations.

---

## 📡 Backend Requirements

Since `auto-dom-i18n` is client-side only, you must provide a backend endpoint to perform the actual translation (e.g., database lookup, translation API, and/or an LLM).

### Request Format
Here is an example of how you might structure the POST body in your callback:

```json
{
  "target": "es",
  "items": [
    {
      "masked": "Welcome back, {{0}}",
      "original": "Welcome back, John",
      "variables": [{ "value": "John", "type": "ignoreWord" }]
    }
  ]
}
```

### Expected Response Format
Your backend must return a JSON object where the **keys** match the `masked` strings sent in the request, and the **values** are strings — either a simple translation or an ICU MessageFormat pattern.

**Simple Response:**
```json
{
  "Welcome back, {{0}}": "Bienvenido de nuevo, {{0}}"
}
```

**ICU MessageFormat Response:**
For cases where simple substitution isn't enough (e.g., words with identical singular/plural forms, or per-variable gender), the backend can return an ICU MessageFormat string:

```json
{
  "{{0}} sheep": "{0, plural, one {# oveja} other {# ovejas}}"
}
```

**ICU with gender metadata:**
```json
{
  "{{0}} bought {{1}} sheep": "{0_gender, select, female {{0} compró} other {{0} compró}} {1, plural, one {# oveja} other {# ovejas}}"
}
```

In ICU responses, use `{N}` (single braces) instead of `{{N}}` (double braces). The library auto-detects the format. Variable metadata from `ignoreWords` is available as `{N_key}` arguments (e.g., `{0_gender}`). Numbers are automatically parsed for proper plural rule evaluation.

**Important Implementation Notes:**
1.  **Preserve Variables:** Your translation logic must preserve the `{{0}}`, `{{1}}` placeholders in the output string (or use `{0}`, `{1}` for ICU format).
2.  **Preserve Tags:** If the input contains `<b0>...</b0>`, the output must also contain `<b0>...</b0>` wrapping the corresponding translated text.
3.  **Context Hints:** Pass the `original` string to your LLM prompt to help it understand context (e.g., that "Save" is a button, or "John" is a name), but always key your response by the `masked` string.

> **Privacy Note:** All visible text content is sent to your `onMissingTranslation` endpoint. If your application displays sensitive data, consider excluding those DOM regions using `ignoreSelectors` or the `data-i18n-ignore` attribute.

---

## 🔌 Programmatic API

While the library primarily works by observing the DOM, you can also interact with the internal cache programmatically. This is useful for SSR hydration, pre-fetching, or imperative usage.

### `start()`

Connects the `MutationObserver` to the configured `rootElement` and begins observing for text changes. Any existing text content is processed immediately.

```javascript
i18n.start();
```

### `setTranslation(locale, data)`

Manually load translations into the cache. This bypasses the network queue and marks these keys as 'resolved'.

```javascript
i18n.setTranslation('es', {
  "Welcome {{0}}": "Bienvenido {{0}}",
  "Save": "Guardar"
});
```

### `getTranslation(key, locale?)`

Retrieves the translation string from the cache. Returns `undefined` if the key is not found.

```javascript
const translation = i18n.getTranslation("Save", "es"); // "Guardar"
```

### `translate(text, variables?)`

Imperatively translate a string using the current locale. Returns the original text (with variables substituted) if no translation is found.

* `text`: The string to translate (e.g. "Hello {{0}}")
* `variables`: *(Optional)* Array of strings to replace placeholders (e.g. `["World"]`)

```javascript
const text = i18n.translate("Welcome {{0}}", ["John"]); // "Bienvenido John"
```

### `setLocale(locale)`

Updates the target locale and re-translates all observed nodes using the new locale's cache. Any uncached keys in the new locale will trigger `onMissingTranslation`. The original text is preserved in the configured `originalAttribute` (default `data-i18n-original`) on each translated element, so switching locales does not require a page reload.

```javascript
i18n.setLocale('fr');
```

### `getIgnoreWords()`

Returns a copy of the current ignore words list.

```javascript
const words = i18n.getIgnoreWords(); // ['Google', 'John Doe']
```

### `addIgnoreWords(...words)`

Adds one or more words to the ignore list and re-translates all observed nodes. Duplicates and empty strings are silently skipped.

```javascript
i18n.addIgnoreWords('Acme', 'Jane Doe');
```

### `removeIgnoreWords(...words)`

Removes one or more words from the ignore list and re-translates all observed nodes. Words not in the list are silently ignored.

```javascript
i18n.removeIgnoreWords('Google');
```

### `setIgnoreWords(words)`

Replaces the entire ignore words list and re-translates all observed nodes. Accepts plain strings or objects with metadata.

```javascript
i18n.setIgnoreWords(['NewBrand', { word: 'Jane', meta: { gender: 'female' } }]);
```

### `stop()`

Disconnects the `MutationObserver` and clears any pending translation queues. Does not clear the cache. Call `start()` to resume observation.

```javascript
i18n.stop();
```

### `getCache(locale?)`

Returns a snapshot of the current translation cache for the given locale (or the current locale if omitted). Useful for persisting translations to `localStorage` or `IndexedDB` and restoring them via `initialCache`.

```javascript
const cache = i18n.getCache('es');
localStorage.setItem('i18n-cache-es', JSON.stringify(cache));
```

### `clearCache(locale?)`

Flushes the translation cache for the given locale, or all locales if omitted. Subsequent DOM observations will re-trigger `onMissingTranslation` for cleared keys.

```javascript
i18n.clearCache('es');
```

---

## 📖 How It Works

### 1. Observation & Masking

The library watches the DOM for text changes. It intelligently masks variables and handles inline HTML to create a normalized "Cache Key".

The library uses three data attributes during translation (all configurable via options):

1.  **`data-i18n-original`:** Stores the original text when a translation is applied. The observer checks this attribute to skip nodes it has already translated, preventing infinite loops. It also enables `setLocale()` to re-translate from the original source.
2.  **`data-i18n-pending`:** Added to elements while a translation request is in-flight. Removed once the translation is applied. Use this for CSS-based FOUC mitigation (e.g., `[data-i18n-pending] { visibility: hidden; }`).
3.  **`data-i18n-key`:** *(Optional, user-provided)* If present on an element, its value is used as the cache key instead of the computed masked string. This is useful when automatic masking produces an ambiguous key, or when you want to share a translation across elements with different source text.
4.  **`data-i18n-ignore`:** *(Optional, user-provided)* If present on an element, the observer will completely skip that element and its entire subtree — no text, attributes, or mutations will be processed. Useful for excluding regions that contain sensitive data, code snippets, or content that should never be translated.

**Example:**

* **Original DOM:** `Please click <a href="/login">here</a> to login.`
* **Masked Key:** `Please click <a0>here</a0> to login.`
* **Variable Map:** `<a0>` maps to `{ href: "/login" }`

*Note: The actual attributes (href, class) are stripped for the translation key but re-applied during restoration.*

### 2. Restoration

The library applies the translation and re-injects all original variables and attributes.

* **Example:** Masked key `Please click <a0>here</a0>` → Translation `Haga clic <a0>aqui</a0>` → Result `Haga clic <a href="/login">aqui</a>`

### 3. Handling Plurals (Automatic)

Since the library observes the rendered DOM, pluralization is handled naturally by the masking process. You do not need to set a global `plural` context.

* **Singular:** `You have 1 apple` becomes `You have {{0}} apple`.
* **Plural:** `You have 5 apples` becomes `You have {{0}} apples`.

These result in **two different cache keys**, allowing your backend to provide distinct translations for each form without complex client-side logic.

#### Same-Form Words (ICU MessageFormat)

Some English words have identical singular and plural forms (e.g., "sheep", "fish", "deer"). These produce the **same cache key** (`{{0}} sheep`), which means the backend can't distinguish "1 sheep" from "5 sheep" using simple substitution alone.

For these cases, the backend should return an **ICU MessageFormat** string instead:

```json
{
  "{{0}} sheep": "{0, plural, one {# oveja} other {# ovejas}}"
}
```

The library detects ICU format automatically (single-brace `{0}` vs double-brace `{{0}}`), parses numeric variables for proper plural rule evaluation, and evaluates the pattern client-side using the [`intl-messageformat`](https://formatjs.io/docs/intl-messageformat/) library. This handles CLDR plural rules for all locales correctly.

> **Note:** For target languages with additional plural forms (e.g., Russian, Arabic, Polish), ICU MessageFormat is the recommended approach. The `intl-messageformat` library supports all CLDR plural categories (`zero`, `one`, `two`, `few`, `many`, `other`).

---

## 🌍 ICU MessageFormat

The library supports [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/) for advanced pluralization and gender handling. This is powered by the [`intl-messageformat`](https://formatjs.io/docs/intl-messageformat/) library.

### When to Use ICU

Use ICU MessageFormat when:
- **Same-form words:** English words like "sheep", "fish", "deer" produce the same cache key regardless of count. ICU `plural` rules let the backend provide correct translations.
- **Per-variable gender/context:** Multiple variables in a sentence have different genders. ICU `select` with metadata lets the backend handle each variable independently.

### How It Works

1. The masker detects each variable's type (`number`, `ignoreWord`, `date`, etc.) and collects metadata from `ignoreWords` config.
2. The backend receives `VariableInfo` objects and can return either:
   - **Simple format** (`{{0}}`): Direct substitution (backward compatible)
   - **ICU format** (`{0}`): Evaluated client-side with `intl-messageformat`
3. The library auto-detects the format: double-brace `{{0}}` = simple, single-brace `{0}` = ICU.

### Variable Arguments

ICU patterns can reference variables by index and their metadata:

| Argument | Source | Example |
| :--- | :--- | :--- |
| `{0}` | Variable value | `"Mary"` or `5` (numbers auto-parsed) |
| `{0_gender}` | Metadata from `ignoreWords` | `"female"` |
| `{0_formality}` | Metadata from `ignoreWords` | `"formal"` |

### Example Flow

**Config:**
```javascript
const i18n = new I18nObserver({
  locale: 'fr',
  ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }],
  onMissingTranslation: async (items, locale) => {
    // items[0].variables = [
    //   { value: "Mary", type: "ignoreWord", meta: { gender: "female" } },
    //   { value: "5", type: "number" }
    // ]
    return await translateWithBackend(items, locale);
  }
});
```

**DOM:** `Mary bought 5 sheep`
**Masked key:** `{{0}} bought {{1}} sheep`

**Backend returns ICU:**
```json
{
  "{{0}} bought {{1}} sheep": "{0_gender, select, female {{0} a acheté} other {{0} a acheté}} {1, plural, one {# mouton} other {# moutons}}"
}
```

**Result:** `Mary a acheté 5 moutons`

---

## 🌐 Browser Support

**auto-dom-i18n** relies on `MutationObserver`, which is supported in all modern browsers:

- Chrome 26+
- Firefox 14+
- Safari 6.1+
- Edge 12+

---

## ⚡ Performance

- **Debounced Updates:** Mutations are batched and debounced (default 200ms) to prevent excessive network requests and DOM re-renders.
- **Hybrid Caching:** Instant synchronous replacement for known strings; asynchronous queuing for new content.
- **Selector Filtering:** Use `ignoreSelectors` to prevent the library from observing high-frequency or sensitive areas (like real-time charts or password fields).
- **Cache Persistence:** The translation cache is in-memory by default. To persist across page loads, use `getCache()` to export it to `localStorage` or `IndexedDB`, then pass it back as `initialCache` on the next initialization. This eliminates redundant network requests and reduces FOUC on repeat visits.

### Reducing Flash of Untranslated Content (FOUC)

On first load, users may briefly see source-language text before translations arrive. To minimize this:

- **Pre-load translations** using `initialCache` or `setTranslation()` before calling `start()`.
- **Hide pending elements** with CSS: `[data-i18n-pending] { visibility: hidden; }`. The library adds this attribute while a translation is in-flight and removes it once applied.
- **SSR hydration:** Call `setTranslation()` with server-provided translations before `start()` to populate the cache immediately.

---

## 🔒 Security

The library reconstructs translated HTML by re-injecting inline tags and attributes into the DOM. Because these translations come from your backend, it is important to ensure the response is trustworthy.

- **Tag allowlist:** Only tags listed in `allowedInlineTags` are permitted in restored output. Any tags not in the allowlist are escaped as plain text.
- **Attribute stripping:** Event handler attributes (e.g., `onclick`, `onerror`) are always stripped from restored tags, even if they appear in the translation response.
- **Recommendation:** Ensure your translation backend is authenticated and returns sanitized content. If using an LLM, validate responses before returning them to the client.

---

## 🐛 Debugging

When something looks wrong with how text is being captured or translated, enable `debug: true` to get DOM context on every translation item. This makes it easy to understand what's happening and to file reproducible bug reports.

```javascript
const i18n = new I18nObserver({
  locale: 'es',
  debug: true, // Enable debug mode
  onMissingTranslation: async (items, locale) => {
    for (const item of items) {
      if (item.debug) {
        console.log('Translation item:', {
          masked: item.masked,
          original: item.original,
          variables: item.variables,
          debug: item.debug,
        });
      }
    }
    // ... your translation logic
  }
});
```

Each item's `debug` field contains:

| Field | Type | Description |
| :--- | :--- | :--- |
| `elementOpenTag` | `string` | The opening HTML tag of the element, including all attributes. E.g., `'<button class="next-btn" data-v-abc="">'`. |
| `childElements` | `Array<{ tag, classes }>` | Direct child elements of the target element. Useful for understanding aggregation behavior. |
| `source` | `string` | How the text was found: `'text'` for text content, or `'attribute:placeholder'`, `'attribute:title'`, etc. for attributes. |

### Reproducing an Issue

The `debug` output is designed to be copy-paste ready for a test case. Given `elementOpenTag` and `original` (the innerHTML), you can reconstruct the DOM:

```
${debug.elementOpenTag}${item.original}</${closing tag}>
```

For example, if a translation item looks wrong and the debug output shows:
```json
{
  "elementOpenTag": "<button>",
  "childElements": [
    { "tag": "DIV", "classes": "spinner" },
    { "tag": "SPAN", "classes": "label" }
  ],
  "source": "text"
}
```

You can immediately see the DOM structure and reconstruct it for a bug report.

---

## 🛠 Framework Integration

While **auto-dom-i18n** is framework-agnostic, here is how you typically initialize it:

### How It Works with Frameworks

When a framework (React, Vue, etc.) re-renders a component, the original untranslated text is written back to the DOM. The library detects this mutation and re-translates it. For cached translations this is instant and invisible. For uncached text, a brief flash may occur on the first render only.

### React / Next.js
Initialize in a `useEffect` at your root layout or app component.
```javascript
useEffect(() => {
  i18n.start();
  return () => i18n.stop();
}, []);
```

### Vue / Nuxt
Initialize in `onMounted` and clean up in `onUnmounted`.
```javascript
onMounted(() => {
  i18n.start();
});
onUnmounted(() => {
  i18n.stop();
});
```

---

## 👩‍💻 Contributors Guide

We welcome contributions! This library is built with TypeScript and uses Vitest for testing.

### Development Setup

1.  **Clone the repo**

    ```bash
    git clone https://github.com/gabepri/auto-dom-i18n.git
    cd auto-dom-i18n
    ```

2.  **Install dependencies**

    ```bash
    npm install
    ```

3.  **Run in development mode**
    We use Vite for the dev server.

    ```bash
    npm run dev
    ```

### Architecture Overview

* **`Observer.ts`**: Manages the `MutationObserver` and DOM filtering. Handles re-entry prevention via the configured `originalAttribute`.
* **`Store.ts`**: The internal state manager. It uses a **Two-Tier Map** (Locale -> Key -> Entry) to store raw variant objects. It is **not** exposed directly to ensure state integrity (handling `pending`, `resolved`, `reported` flags).
* **`Queue.ts`**: Manages debouncing and batching of translation requests. Collects pending items during the `debounceTime` window and dispatches them in chunks of `maxBatchSize` to the `onMissingTranslation` callback.
* **`Masker.ts`**: Handles regex logic for variables (`{{0}}`), attribute stripping (`<a0>`), and ICU MessageFormat evaluation.
* **`Translator.ts`**: Coordinates the Cache, Network requests, and DOM updates.

### Testing

```bash
# Run unit tests
npm run test
```

## 📄 License

MIT © [gabepri](https://github.com/gabepri)