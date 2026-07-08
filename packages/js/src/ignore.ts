/** Config needed to decide whether a node sits inside an ignored subtree. */
export interface IgnoreConfig {
  rootElement: Node;
  ignoreAttribute: string;
  ignoreSelectors: string[];
}

/** The attribute/selector half of {@link IgnoreConfig} — all a single-element check needs. */
export type IgnorePredicateConfig = Pick<IgnoreConfig, 'ignoreAttribute' | 'ignoreSelectors'>;

// Private-use sentinels that bracket an ignored subtree inside an aggregated
// unit's serialized HTML. The Masker turns each bracketed region into one opaque
// {{N}} variable, so an ignored descendant's text never enters the cache key.
// PUA characters so they can't collide with real markup or the Masker's own
// masking sentinels, and survive its BIDI-control stripping untouched.
export const IGNORE_OPEN = '\uE000';
export const IGNORE_CLOSE = '\uE001';

// Tag name of the throwaway placeholder element the ignored-slot morph path
// emits (via the Masker) and the Translator swaps for the live ignored DOM node.
export const IGNORED_PLACEHOLDER_TAG = 'i18n-ignored';

/**
 * True when `el` itself is an ignore boundary — it carries `ignoreAttribute` or
 * matches one of `ignoreSelectors`. This is the per-element half of the ignore
 * decision, reused by the ancestor walk ({@link isInsideIgnored}) and by the
 * aggregation path, which needs to spot an ignored *descendant* of a target that
 * is not itself ignored.
 */
export function isIgnoredElement(el: Element, config: IgnorePredicateConfig): boolean {
  if (el.hasAttribute(config.ignoreAttribute)) {
    return true;
  }
  for (const selector of config.ignoreSelectors) {
    if (el.matches(selector)) {
      return true;
    }
  }
  return false;
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
    if (current instanceof Element && isIgnoredElement(current, config)) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Serializes an aggregation target's inner HTML, but wraps every topmost ignored
 * descendant subtree in {@link IGNORE_OPEN}…{@link IGNORE_CLOSE} sentinels. The
 * Masker then masks each wrapped region as one opaque variable, so an ignored
 * descendant's (user-data) text is excluded from the translatable unit while its
 * markup is preserved verbatim for restoration.
 *
 * Returns plain `innerHTML` unchanged when the target has no ignored descendant,
 * so non-ignoring aggregation is byte-for-byte what it was before.
 */
export function serializeAggregate(target: Element, config: IgnorePredicateConfig): string {
  const selector = ignoreSelector(config);
  if (!target.querySelector(selector)) {
    return target.innerHTML;
  }

  // Detect ignored nodes on the live tree (so ancestor-aware selectors resolve
  // correctly) but bracket them in a detached clone, which we read back as an
  // accurate browser serialization without touching the live DOM.
  const clone = target.cloneNode(true) as Element;
  wrapIgnoredRegions(target, clone, config);
  return clone.innerHTML;
}

/** Removes the aggregation sentinels, yielding the clean original inner HTML. */
export function stripIgnoreSentinels(html: string): string {
  if (html.indexOf(IGNORE_OPEN) === -1) return html;
  return html.split(IGNORE_OPEN).join('').split(IGNORE_CLOSE).join('');
}

/**
 * Collects the topmost ignored descendant elements of `element`, in document
 * order — the live DOM nodes an aggregated apply splices back in place of the
 * opaque variables. Does not descend into an ignored subtree, matching how
 * {@link serializeAggregate} brackets only the outermost boundary.
 */
export function collectTopLevelIgnored(element: Element, config: IgnorePredicateConfig): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element): void => {
    for (const child of parent.children) {
      if (isIgnoredElement(child, config)) {
        out.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(element);
  return out;
}

function wrapIgnoredRegions(live: Element, clone: Element, config: IgnorePredicateConfig): void {
  const liveChildren = Array.from(live.childNodes);
  const cloneChildren = Array.from(clone.childNodes);
  for (let i = 0; i < liveChildren.length; i++) {
    const liveChild = liveChildren[i]!;
    const cloneChild = cloneChildren[i]!;
    if (liveChild.nodeType === Node.ELEMENT_NODE) {
      if (isIgnoredElement(liveChild as Element, config)) {
        clone.insertBefore(clone.ownerDocument.createTextNode(IGNORE_OPEN), cloneChild);
        clone.insertBefore(clone.ownerDocument.createTextNode(IGNORE_CLOSE), cloneChild.nextSibling);
      } else {
        wrapIgnoredRegions(liveChild as Element, cloneChild as Element, config);
      }
    }
  }
}

function ignoreSelector(config: IgnorePredicateConfig): string {
  const parts = [`[${config.ignoreAttribute}]`, ...config.ignoreSelectors];
  return parts.join(', ');
}
