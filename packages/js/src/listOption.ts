import type { ListOption } from './types';

/**
 * Resolves one list-valued config option against the library's default list.
 *
 * This is the single implementation of the convention every list option follows —
 * there are deliberately no per-option flags and no `extra*`/`inherit*` variants:
 *
 * - `undefined` → the defaults.
 * - a plain array → the **union** of the defaults and the consumer's entries,
 *   deduplicated. The common "everything you ship, plus mine" case, and the reason
 *   a consumer keeps receiving new default entries when they upgrade.
 * - a function → full control. It receives the defaults and its return value is used
 *   **verbatim**, with no further merging: removal (`(d) => d.filter(...)`),
 *   reordering, or outright replacement (`() => ['mine']`).
 *
 * `dedupeKey` extracts the identity of an entry; it defaults to the entry itself, which
 * is right for string lists. Object lists pass their identifying field (e.g. `s => s.id`).
 * On collision the consumer's entry wins, but keeps the default's position — so a
 * consumer overriding one built-in entry doesn't reshuffle the rest of the list.
 */
export function resolveListOption<T>(
  userValue: ListOption<T> | undefined,
  defaults: readonly T[],
  dedupeKey: (entry: T) => unknown = (entry) => entry
): T[] {
  if (typeof userValue === 'function') {
    return userValue([...defaults]);
  }
  if (userValue === undefined) {
    return [...defaults];
  }

  // Map preserves first-insertion order while `set` overwrites the value, which is
  // exactly "default's position, consumer's entry".
  const merged = new Map<unknown, T>();
  for (const entry of defaults) {
    merged.set(dedupeKey(entry), entry);
  }
  for (const entry of userValue) {
    merged.set(dedupeKey(entry), entry);
  }
  return [...merged.values()];
}
