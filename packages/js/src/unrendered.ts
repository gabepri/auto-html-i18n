/**
 * Detects a mask captured from a half-rendered UI.
 *
 * A component that paints before its data arrives puts the *stringified absence* of
 * the value into the DOM: "Level undefined", "Read time about NaN minutes", "results
 * for ''". None of those tokens match a number/date/symbol pattern, so the Masker sees
 * no variable and bakes the broken value into the key as literal text.
 *
 * Such an entry is dead on arrival. It can never be hit again — once the data loads the
 * same UI masks to "Level {{0}}", a different key — and it poisons machine translation
 * downstream: an LLM reads "undefined" as a count and invents an ICU argument the client
 * never supplies, so the row fails validation and is resubmitted forever.
 *
 * The predicate is deliberately conservative: the tokens must stand alone, so copy that
 * legitimately contains them ("undefinedish", "Annulled", "Naan") is left alone. The
 * empty-quote rule is the loosest of the set (it targets a search box rendering an empty
 * query); a corpus that legitimately displays empty quotes should override the predicate
 * via `isUnrenderedValue`, or turn the gate off with `skipUnrenderedValues: false`.
 */

// Whole-word only, and case-sensitive: these are the exact strings the JS runtimes
// stringify a missing value to. Lookarounds rather than \b so a non-ASCII letter beside
// the token still counts as a word character.
const UNRENDERED_TOKEN = /(?<![\p{L}\p{N}_])(?:undefined|null|NaN)(?![\p{L}\p{N}_])/u;

// A value that rendered as the empty string, still wearing the quotes the copy put
// around it.
const EMPTY_QUOTE_PAIR = /''|""|«»|‘’|“”/;

/** The default `UnrenderedValuePredicate` (the `original` a caller passes is unused). */
export function isUnrenderedValue(masked: string): boolean {
  return UNRENDERED_TOKEN.test(masked) || EMPTY_QUOTE_PAIR.test(masked);
}
