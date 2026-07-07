/** Config needed to decide whether a node sits inside an ignored subtree. */
export interface IgnoreConfig {
  rootElement: Node;
  ignoreAttribute: string;
  ignoreSelectors: string[];
}

/**
 * True when `node` is inside a subtree the user asked us to skip — either an
 * ancestor carries `ignoreAttribute` or matches one of `ignoreSelectors`. Walks
 * up from `node` to (but not past) `rootElement`.
 *
 * This is the single source of truth for the ignore decision. It runs at
 * collection time (Observer's TreeWalker / MutationObserver) as a cheap early
 * filter, and again at flush time (I18nObserver's flush guard) to catch nodes
 * that only settled under an ignore ancestor after they were collected — e.g. a
 * portalled dropdown whose ancestry isn't established until a beat later.
 */
export function isInsideIgnored(node: Node, config: IgnoreConfig): boolean {
  let current: Node | null = node;
  while (current && current !== config.rootElement) {
    if (current instanceof Element) {
      if (current.hasAttribute(config.ignoreAttribute)) {
        return true;
      }
      for (const selector of config.ignoreSelectors) {
        if (current.matches(selector)) {
          return true;
        }
      }
    }
    current = current.parentNode;
  }
  return false;
}
