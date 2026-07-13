# Shared masker fixtures

Behavior-critical Masker test cases shared across language ports. Both `packages/js` and `packages/php` load these and assert their local Masker reproduces the expected output. Adding a fixture exercises every port automatically.

## Schema

Each fixture file is a JSON array of cases:

```json
[
  {
    "name": "human-readable description",
    "input": "You have 5 apples",
    "config": {
      "ignoreWords": ["..."],
      "allowedInlineTags": ["a", "b", ...]
    },
    "expected": {
      "masked": "You have {{0}} apples",
      "variables": [{ "value": "5", "type": "number" }],
      "tagAttributes": { "a0": { "href": "/x" } },
      "casePattern": "lower",
      "leadingWhitespace": "",
      "trailingWhitespace": ""
    }
  }
]
```

### Defaults

- `config.ignoreWords` defaults to `[]`
- `config.allowedInlineTags` defaults to `["a", "b", "i", "u", "strong", "em", "span", "small", "mark", "del"]`
- `expected.tagAttributes` defaults to `{}`
- `expected.casePattern` defaults to `"lower"`
- `expected.leadingWhitespace` and `expected.trailingWhitespace` default to `""`

### `ignoreWords` entries

Either a plain string or an object with metadata:

```json
"Mary"
{ "word": "Mary", "meta": { "gender": "female" } }
```

When metadata is present, the corresponding `expected.variables[]` entry should include a `meta` field.

## Categories

- `masker/numbers.json` — integers, decimals, negatives, percentages
- `masker/dates.json` — MM/DD/YYYY, YYYY-MM-DD, DD.MM.YYYY
- `masker/ignore-words.json` — string entries, multi-word, longest-first
- `masker/urls-emails.json` — URLs and email addresses
- `masker/symbols.json` — ©, ®, ™, currency, miscellaneous
- `masker/inline-tags.json` — tag normalization, attribute extraction, nesting
- `masker/comments.json` — HTML comments masked as variables
- `masker/case-detection.json` — upper/lower/mixed pattern detection
- `masker/whitespace.json` — leading/trailing whitespace handling
- `unrendered/*.json` — half-rendered-value detection: which masks are artifacts of a UI that painted before its data arrived, and so must never be reported. Cases have a different shape from the masker ones:

```json
{ "name": "trailing undefined value", "masked": "Level undefined", "expected": true }
```

## Adding a fixture

1. Pick the right category file (or create a new one).
2. Add a case with a descriptive `name`.
3. Run the JS suite (`cd packages/js && npm run test`) — the fixture-driven test will pick it up.
4. Run the PHP suite once that port exists. Failures here mean the ports diverge — fix in whichever port is wrong.
