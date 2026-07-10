import type { CasePattern, TranslationEntry, TranslationItem, TranslationItemDebug, OnMissingTranslationCallback, MaskResult, VariableInfo } from './types';
import { Store } from './Store';
import { Queue } from './Queue';
import { Masker } from './Masker';
import { stripIgnoreSentinels, collectTopLevelIgnored, isIgnoredElement, IGNORED_PLACEHOLDER_TAG, type IgnorePredicateConfig } from './ignore';

/**
 * NODE-PRESERVATION INVARIANT
 *
 * Every write this class makes to already-translated content is an in-place
 * morph: it reuses the existing Text / Element / Comment nodes and rewrites their
 * data, never `textContent =` / `innerHTML =` / `replaceChildren` on live,
 * tracked content. The reason is framework safety. An aggregation target or leaf
 * can hold nodes a framework (Vue, React, …) tracks as vnodes — a `<RouterLink>`
 * slot's text, a component root, a `<!--v-if-->` anchor comment. Recreating such
 * a node severs the framework's vdom↔DOM link; it doesn't fail immediately but
 * dereferences null on the next patch or unmount (menu flyouts, route
 * navigation), which is why swapping a node out crashes later, not now.
 *
 * So apply ({@link Translator.morphInto}/{@link Translator.reconcileChildren}),
 * leaf text ({@link Translator.setLeafText}), ignored-node restoration, and
 * revert ({@link Translator.morphOriginalInto}) all morph in place. The one
 * sanctioned exception is {@link Translator.rebuildChildren}: when the translated
 * shape genuinely can't map 1:1 onto the existing nodes (ICU branch selection, or
 * a tag the translation added/dropped) there is no stable node to preserve, so it
 * replaces the *content* wholesale and accepts the identity loss. Framework-owned
 * structural children are still carried across it ({@link Translator.isStructuralChild}):
 * losing a listener degrades the page, losing an anchor crashes the framework.
 *
 * Comments below take this as given and note only the local mechanism.
 */

// ICU plural/select constructs pick one branch at evaluation time, so the masked
// markers (in every branch) can't line up with the evaluated output — the morph
// isn't reconcilable and falls back to a wholesale rebuild (see invariant above).
const ICU_PATTERN = /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\b/;

export interface TranslatorConfig {
  locale: string;
  originalAttribute: string;
  pendingAttribute: string;
  keyAttribute: string;
  scopeAttribute: string;
  translatableAttributes: string[];
  onMissingTranslation: OnMissingTranslationCallback;
  debug: boolean;
  /**
   * Canonical string form of an aggregated (`isHtml`) element — the Observer's
   * `serializeAggregate`, which brackets ignored descendants so the two sides
   * agree on what an element's content "is". Defaults to plain `innerHTML`
   * (no ignored-subtree handling) when omitted.
   */
  serializeAggregate?: (element: Element) => string;
  /** Attribute/selectors identifying ignore boundaries; used to preserve live nodes on apply. */
  ignorePredicate?: IgnorePredicateConfig;
}

interface PendingNode {
  element: Element;
  variables: VariableInfo[];
  tagAttributes: Map<string, Record<string, string>>;
  casePattern: CasePattern;
  leadingWhitespace: string;
  trailingWhitespace: string;
  originalText: string;
  /** Displayed content at tracking time — if it changed since, the node is stale. */
  snapshot: string;
  isAttribute?: boolean;
  attrName?: string;
  isHtml: boolean;
  scope?: string;
  /** Set when the unit is scoped to one leaf Text node rather than the whole element. */
  textNode?: Text;
}

export class Translator {
  private store: Store;
  private queue: Queue;
  private masker: Masker;
  private config: TranslatorConfig;
  private pendingNodes = new Map<string, Set<PendingNode>>();
  // Last output we wrote per element/attribute. Lets us tell our own mutation
  // echoes apart from external rewrites (frameworks patching translated nodes),
  // and protects newer content from stale applies and reverts.
  private lastApplied = new WeakMap<Element, string>();
  private lastAppliedAttrs = new WeakMap<Element, Map<string, string>>();
  // Marker identity (e.g. "a0", "span1") recorded per inline child element we've
  // placed in an aggregated unit, so a later re-translate can reuse the same live
  // nodes even when a translation reordered them. See morphInto/buildMarkerToNode.
  private nodeMarkers = new WeakMap<Element, string>();
  // Text nodes we emptied ourselves (an ICU arm rendered nothing). Without this they'd
  // be indistinguishable from a framework fragment anchor and skipped forever. See
  // isAnchorText/setTextData.
  private emptiedByUs = new WeakSet<Text>();
  // A non-aggregatable parent holds one translation unit PER direct text node
  // (`<p>one<br>two</p>` is two units), so unit state can't hang off the element or the
  // second apply overwrites the first node and reclaims the rest. These are the
  // element-keyed `lastApplied` / `data-i18n-original` pair, per Text node.
  // `ownsText` records that at least one of an element's units is ours, which is what
  // tells an externally-rewritten node apart from server-rendered content.
  private textUnits = new WeakMap<Text, { original: string; lastApplied: string }>();
  private ownsText = new WeakSet<Element>();
  // Value-based, locale-scoped echo guard. Maps the normalized (masked) form of
  // every output we've actually written to the DOM -> the source text it came
  // from, per locale. Unlike `lastApplied` (keyed on element identity + exact
  // string), this survives a framework re-creating the node (transition, v-if,
  // keyed reorder) and any whitespace drift: when a swapped-in node carries our
  // own translation as its "source" text, we recognize it here and re-establish
  // the marker instead of reporting it as a fresh source string. Keyed by locale
  // so an output for locale A never suppresses reporting under locale B.
  private appliedOutputs = new Map<string, Map<string, string>>();
  // Canonical serialization / ignore predicate for aggregated elements, injected
  // so the Translator stays free of ignore/root config. Defaults keep behavior
  // identical for callers (e.g. tests) that don't wire them up.
  private serializeAggregate: (element: Element) => string;
  private ignorePredicate: IgnorePredicateConfig;

  constructor(
    store: Store,
    queue: Queue,
    masker: Masker,
    config: TranslatorConfig
  ) {
    this.store = store;
    this.queue = queue;
    this.masker = masker;
    this.config = config;
    this.serializeAggregate = config.serializeAggregate ?? ((element) => element.innerHTML);
    this.ignorePredicate = config.ignorePredicate ?? { ignoreAttribute: '', ignoreSelectors: [] };
  }

  /** Current displayed content of an element in its canonical string form. */
  private currentContent(element: Element, isHtml: boolean): string {
    return isHtml ? this.serializeAggregate(element) : (element.textContent ?? '');
  }

  /**
   * `textNode`, when given, scopes the unit to that leaf Text node rather than to the
   * element — the element may hold several (`<p>one<br>two</p>`). Omitted for aggregated
   * (`isHtml`) units, and by direct callers treating the element's text as one unit.
   */
  processText(element: Element, originalText: string, textNode?: Text): void {
    const last = textNode ? this.textUnits.get(textNode)?.lastApplied : this.lastApplied.get(element);
    if (last !== undefined && originalText === last) {
      return; // echo of our own write
    }
    if (element.hasAttribute(this.config.originalAttribute)) {
      // The attribute marks the element, but a node unit's ownership is per node: a
      // sibling text node we already translated must not make THIS one look
      // server-rendered, or it would never be translated at all.
      const ours = textNode ? this.ownsText.has(element) : last !== undefined;
      if (!ours) {
        return; // translated content we didn't write (e.g. server-rendered)
      }
      // Externally rewritten after we translated it — the marker is stale;
      // treat the incoming text as fresh source
      if (textNode) {
        this.textUnits.delete(textNode);
      } else {
        element.removeAttribute(this.config.originalAttribute);
        this.lastApplied.delete(element);
      }
    }

    const keyOverride = element.getAttribute(this.config.keyAttribute);
    const isHtml = /<[^>]+>/.test(originalText);
    const maskResult = this.masker.mask(originalText);

    // Skip if masked text has no translatable content (only variables, tags, whitespace, punctuation)
    if (!keyOverride && !hasTranslatableContent(maskResult.masked)) {
      return;
    }

    // Value-based echo guard. The element-identity checks above miss our own
    // output when a framework re-created the node (so it carries neither our
    // `lastApplied` entry nor the `data-i18n-original` marker) or when whitespace
    // drift defeated the exact-equality check. Compare the *normalized* incoming
    // text against the outputs we've actually applied in this locale; if it's one
    // of ours, re-establish the marker on THIS node and stop — never report our
    // own translation as fresh source (which would mint a bogus target-language
    // row). Accepted trade-off: a genuinely new source string that coincidentally
    // equals a prior translation OUTPUT in the active locale is suppressed. Rare,
    // and strongly preferable to leaking target-language rows.
    const echoedOriginal = this.appliedOutputs.get(this.config.locale)?.get(maskResult.masked);
    if (echoedOriginal !== undefined) {
      if (textNode) {
        this.textUnits.set(textNode, { original: echoedOriginal, lastApplied: textNode.data });
        this.syncOriginalAttribute(element);
      } else {
        element.setAttribute(this.config.originalAttribute, echoedOriginal);
        this.lastApplied.set(element, this.currentContent(element, isHtml));
      }
      element.removeAttribute(this.config.pendingAttribute);
      return;
    }

    const cacheKey = keyOverride ?? maskResult.masked;
    const scope = this.resolveScope(element);

    const entry = this.store.get(this.config.locale, cacheKey);

    if (entry && entry.status === 'resolved' && entry.value !== null) {
      const resolved = resolveEntry(entry.value, scope);
      if (resolved) {
        this.applyTranslation(element, resolved, maskResult, originalText, isHtml, maskResult.casePattern, textNode);
      }
      return;
    }

    // Build item before mutating the element so debug info captures original state
    const item = this.buildItem(cacheKey, originalText, maskResult.variables, element, 'text', scope);

    element.setAttribute(this.config.pendingAttribute, '');

    if (entry && (entry.status === 'pending' || entry.status === 'reported')) {
      this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml, scope, textNode);
      return;
    }

    this.store.markPending(this.config.locale, cacheKey);
    this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml, scope, textNode);
    this.queue.enqueue(item);
  }

  /**
   * Point `data-i18n-original` at the first node unit's original. The attribute is per
   * element but an element can hold several node units, so it can only ever name one of
   * them; {@link textUnits} holds each node's exact original. Recomputed from the live
   * nodes on every apply so an externally-rewritten unit doesn't leave a stale value
   * behind. Also marks the element as ours, which is what tells an external rewrite apart
   * from server-rendered content.
   */
  private syncOriginalAttribute(element: Element): void {
    this.ownsText.add(element);
    const first = this.nodeUnitsOf(element)[0];
    if (first) element.setAttribute(this.config.originalAttribute, first.original);
  }

  processAttribute(element: Element, attr: string, originalValue: string): void {
    const originalAttrName = `${this.config.originalAttribute}-${attr}`;
    const lastAttrs = this.lastAppliedAttrs.get(element);
    const last = lastAttrs?.get(attr);

    if (last !== undefined && originalValue === last) {
      return; // echo of our own write
    }
    if (element.hasAttribute(originalAttrName)) {
      if (last === undefined) {
        return; // translated attribute we didn't write (e.g. server-rendered)
      }
      // Externally rewritten after we translated it — the marker is stale
      element.removeAttribute(originalAttrName);
      lastAttrs?.delete(attr);
    }

    const maskResult = this.masker.mask(originalValue);

    if (!hasTranslatableContent(maskResult.masked)) {
      return;
    }

    // Value-based echo guard (see processText): recognize an attribute value that
    // is our own applied output re-collected on a framework-recreated node, and
    // re-establish its marker instead of reporting it as new source.
    const echoedOriginal = this.appliedOutputs.get(this.config.locale)?.get(maskResult.masked);
    if (echoedOriginal !== undefined) {
      element.setAttribute(originalAttrName, echoedOriginal);
      // `originalValue` is the recognized output currently displayed — record it
      // as the last-applied marker so a later exact echo short-circuits.
      this.attrMapFor(element).set(attr, originalValue);
      return;
    }

    const cacheKey = maskResult.masked;
    const scope = this.resolveScope(element);

    const entry = this.store.get(this.config.locale, cacheKey);

    if (entry && entry.status === 'resolved' && entry.value !== null) {
      const resolved = resolveEntry(entry.value, scope);
      if (resolved) {
        this.applyAttributeTranslation(element, attr, resolved, maskResult, originalValue);
        element.setAttribute(originalAttrName, originalValue);
      }
      return;
    }

    if (!entry) {
      this.store.markPending(this.config.locale, cacheKey);
      this.queue.enqueue(
        this.buildItem(cacheKey, originalValue, maskResult.variables, element, `attribute:${attr}`, scope)
      );
    }

    const pendingNode: PendingNode = {
      element,
      variables: maskResult.variables,
      tagAttributes: maskResult.tagAttributes,
      casePattern: maskResult.casePattern,
      leadingWhitespace: maskResult.leadingWhitespace,
      trailingWhitespace: maskResult.trailingWhitespace,
      originalText: originalValue,
      snapshot: originalValue,
      isAttribute: true,
      attrName: attr,
      isHtml: false,
      scope,
    };
    this.addToPendingSet(cacheKey, pendingNode);
  }

  applyPending(cacheKey: string): void {
    const pending = this.pendingNodes.get(cacheKey);
    if (!pending) return;

    const entry = this.store.get(this.config.locale, cacheKey);
    if (!entry || entry.status !== 'resolved' || entry.value === null) return;

    for (const node of pending) {
      if (!node.element.isConnected) continue;
      if (node.textNode && !node.textNode.isConnected) continue;

      const resolved = resolveEntry(entry.value, node.scope);
      if (!resolved) continue;

      if (node.isAttribute && node.attrName) {
        // Skip if the attribute changed since it was tracked — the newer
        // value has its own translation cycle
        if (node.element.getAttribute(node.attrName) !== node.snapshot) continue;

        this.applyAttributeTranslation(node.element, node.attrName, resolved, node, node.originalText);
        const originalAttrName = `${this.config.originalAttribute}-${node.attrName}`;
        node.element.setAttribute(originalAttrName, node.originalText);
      } else {
        // Skip if the content changed since it was tracked — the newer
        // content has its own translation cycle
        const current = node.textNode ? node.textNode.data : this.currentContent(node.element, node.isHtml);
        if (current !== node.snapshot) continue;

        this.applyTranslation(node.element, resolved, {
          masked: cacheKey,
          variables: node.variables,
          tagAttributes: node.tagAttributes,
          casePattern: node.casePattern,
          leadingWhitespace: node.leadingWhitespace,
          trailingWhitespace: node.trailingWhitespace,
        }, node.originalText, node.isHtml, node.casePattern, node.textNode);
      }
    }

    this.pendingNodes.delete(cacheKey);
  }

  /**
   * The element's node-scoped units, each with the original we recorded for it. Empty for
   * an aggregated element, and for one whose `data-i18n-original` we didn't write
   * (server-rendered) — both of which are handled as a single element-wide unit.
   */
  private nodeUnitsOf(element: Element): Array<{ node: Text; original: string; lastApplied: string }> {
    const units: Array<{ node: Text; original: string; lastApplied: string }> = [];
    for (const child of element.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const rec = this.textUnits.get(child as Text);
      if (rec) units.push({ node: child as Text, ...rec });
    }
    return units;
  }

  /** Re-apply one unit (element-wide, or scoped to `textNode`) under the current locale. */
  private retranslateUnit(element: Element, originalText: string, isHtml: boolean, textNode?: Text): void {
    const keyOverride = element.getAttribute(this.config.keyAttribute);
    const maskResult = this.masker.mask(originalText);

    if (!keyOverride && !hasTranslatableContent(maskResult.masked)) {
      return;
    }

    const cacheKey = keyOverride ?? maskResult.masked;
    const scope = this.resolveScope(element);

    // Skip units whose content changed since we last wrote them — the
    // marker is stale and re-applying would clobber the newer content
    const lastKnown = textNode ? this.textUnits.get(textNode)?.lastApplied : this.lastApplied.get(element);
    const current = textNode ? textNode.data : this.currentContent(element, isHtml);
    if (lastKnown !== undefined && current !== lastKnown) {
      return;
    }

    const entry = this.store.get(this.config.locale, cacheKey);
    if (entry && entry.status === 'resolved' && entry.value !== null) {
      const resolved = resolveEntry(entry.value, scope);
      if (resolved) {
        this.applyTranslation(element, resolved, maskResult, originalText, isHtml, maskResult.casePattern, textNode);
      }
    } else if (!entry) {
      const item = this.buildItem(cacheKey, originalText, maskResult.variables, element, 'text', scope);
      element.setAttribute(this.config.pendingAttribute, '');
      this.store.markPending(this.config.locale, cacheKey);
      this.trackPendingNode(cacheKey, element, maskResult, originalText, isHtml, scope, textNode);
      this.queue.enqueue(item);
    }
  }

  retranslateAll(): void {
    const elements = document.querySelectorAll(
      `[${this.config.originalAttribute}]`
    );
    for (const element of elements) {
      // An element may hold several node-scoped units, and the attribute can only name
      // one. When the units are ours, they — not the attribute — are the source of truth;
      // a unit whose node the framework replaced simply isn't there any more, and
      // re-applying the attribute's original over the new content would clobber it.
      if (this.ownsText.has(element)) {
        for (const unit of this.nodeUnitsOf(element)) this.retranslateUnit(element, unit.original, false, unit.node);
        continue;
      }

      const originalText = element.getAttribute(this.config.originalAttribute);
      if (!originalText) continue;
      this.retranslateUnit(element, originalText, /<[^>]+>/.test(originalText));
    }

    // Re-translate attributes with original-tracking data
    for (const attr of this.config.translatableAttributes) {
      const originalAttrName = `${this.config.originalAttribute}-${attr}`;
      const attrElements = document.querySelectorAll(`[${originalAttrName}]`);

      for (const element of attrElements) {
        const originalValue = element.getAttribute(originalAttrName);
        if (!originalValue) continue;

        const maskResult = this.masker.mask(originalValue);
        if (!hasTranslatableContent(maskResult.masked)) continue;

        // Skip attributes whose value changed since we last wrote them
        const lastKnown = this.lastAppliedAttrs.get(element)?.get(attr);
        if (lastKnown !== undefined && element.getAttribute(attr) !== lastKnown) {
          continue;
        }

        const cacheKey = maskResult.masked;
        const scope = this.resolveScope(element);
        const entry = this.store.get(this.config.locale, cacheKey);

        if (entry && entry.status === 'resolved' && entry.value !== null) {
          const resolved = resolveEntry(entry.value, scope);
          if (resolved) {
            this.applyAttributeTranslation(element, attr, resolved, maskResult, originalValue);
          }
        } else if (!entry) {
          const item = this.buildItem(cacheKey, originalValue, maskResult.variables, element, `attribute:${attr}`, scope);
          this.store.markPending(this.config.locale, cacheKey);
          const pendingNode: PendingNode = {
            element,
            variables: maskResult.variables,
            tagAttributes: maskResult.tagAttributes,
            casePattern: maskResult.casePattern,
            leadingWhitespace: maskResult.leadingWhitespace,
            trailingWhitespace: maskResult.trailingWhitespace,
            originalText: originalValue,
            // Currently displaying the previous locale's output, not the original
            snapshot: element.getAttribute(attr) ?? '',
            isAttribute: true,
            attrName: attr,
            isHtml: false,
            scope,
          };
          this.addToPendingSet(cacheKey, pendingNode);
          this.queue.enqueue(item);
        }
      }
    }
  }

  revertAll(): void {
    // Revert text nodes
    const elements = document.querySelectorAll(
      `[${this.config.originalAttribute}]`
    );
    for (const element of elements) {
      if (this.ownsText.has(element)) {
        // Each node carries its own original; restore only the nodes still showing what
        // we wrote. A unit the framework replaced is simply absent, and its newer content
        // stays — the attribute's original is stale for it.
        for (const unit of this.nodeUnitsOf(element)) {
          if (unit.node.data === unit.lastApplied) this.setTextData(unit.node, unit.original);
          this.textUnits.delete(unit.node);
        }
        this.ownsText.delete(element);
      } else {
        const originalText = element.getAttribute(this.config.originalAttribute);
        if (originalText) {
          const isHtml = /<[^>]+>/.test(originalText);
          // Only restore if the content is still what we wrote — otherwise the
          // element was rewritten since and the newer content wins
          const lastKnown = this.lastApplied.get(element);
          const current = this.currentContent(element, isHtml);
          if (lastKnown === undefined || current === lastKnown) {
            if (isHtml) {
              // Symmetric to the apply path: morph the original back on in place
              // (node-preservation invariant). The stored original is the canonical
              // sentinel-bracketed form, so re-masking reproduces the same
              // markers/variables morphInto used on apply.
              this.morphOriginalInto(element, originalText);
            } else {
              this.setLeafText(element, originalText);
            }
          }
        }
      }
      element.removeAttribute(this.config.originalAttribute);
      element.removeAttribute(this.config.pendingAttribute);
      this.lastApplied.delete(element);
    }

    // Revert attributes
    for (const attr of this.config.translatableAttributes) {
      const originalAttrName = `${this.config.originalAttribute}-${attr}`;
      const attrElements = document.querySelectorAll(`[${originalAttrName}]`);
      for (const element of attrElements) {
        const originalValue = element.getAttribute(originalAttrName);
        if (originalValue) {
          const lastKnown = this.lastAppliedAttrs.get(element)?.get(attr);
          if (lastKnown === undefined || element.getAttribute(attr) === lastKnown) {
            element.setAttribute(attr, originalValue);
          }
          this.lastAppliedAttrs.get(element)?.delete(attr);
        }
        element.removeAttribute(originalAttrName);
      }
    }

    // Remove pending attributes from any remaining pending-only elements
    const pendingElements = document.querySelectorAll(
      `[${this.config.pendingAttribute}]`
    );
    for (const element of pendingElements) {
      element.removeAttribute(this.config.pendingAttribute);
    }

    this.pendingNodes.clear();
  }

  clearPending(): void {
    this.pendingNodes.clear();
  }

  /**
   * Flush-time re-validation guard. The collection-time ignore check runs once,
   * when a node is first seen; portalled/late-mounted content can settle under an
   * ignore ancestor (or unmount entirely) in the debounce window before the batch
   * is reported. For each item, look at the DOM node(s) we still track for it and
   * keep the item only if at least one is live and not ignored. Drop items whose
   * every tracked node is ignored or detached, forgetting their pending state so
   * the same string can be collected again if it legitimately reappears later.
   *
   * `isIgnored` is injected (the shared ignore predicate) so the Translator stays
   * free of ignore/root config.
   */
  filterReportable(
    items: TranslationItem[],
    isIgnored: (node: Node) => boolean
  ): TranslationItem[] {
    const reportable: TranslationItem[] = [];
    for (const item of items) {
      const nodes = this.pendingNodes.get(item.masked);
      // No tracked nodes (already applied/cleared, or never tracked): nothing to
      // re-validate against — preserve the pre-guard behavior and report it.
      if (!nodes || nodes.size === 0) {
        reportable.push(item);
        continue;
      }

      let hasLive = false;
      for (const node of nodes) {
        if (node.element.isConnected && !isIgnored(node.element)) {
          hasLive = true;
          break;
        }
      }

      if (hasLive) {
        reportable.push(item);
      } else {
        this.pendingNodes.delete(item.masked);
        this.store.resetIfPending(this.config.locale, item.masked);
      }
    }
    return reportable;
  }

  setLocale(locale: string): void {
    this.config.locale = locale;
  }

  get locale(): string {
    return this.config.locale;
  }

  private resolveScope(element: Element): string | undefined {
    let current: Element | null = element;
    while (current) {
      const scope = current.getAttribute(this.config.scopeAttribute);
      if (scope) return scope;
      current = current.parentElement;
    }
    return undefined;
  }

  private applyTranslation(
    element: Element,
    value: string,
    maskResult: MaskResult,
    originalText: string,
    isHtml: boolean,
    casePattern: CasePattern,
    textNode?: Text
  ): void {
    const unmasked = this.masker.unmask(value, maskResult.variables, maskResult.tagAttributes, this.config.locale, originalText);
    const output = maskResult.leadingWhitespace + this.masker.applyCasePattern(unmasked, casePattern) + maskResult.trailingWhitespace;

    if (isHtml) {
      // When the unit contains ignored subtrees, morph off a placeholder
      // rendering (each ignored slot an empty marker element) so we can splice
      // the live ignored DOM nodes back in rather than reconstruct them.
      let placeholderOutput: string | undefined;
      if (maskResult.variables.some((v) => v.type === 'ignored')) {
        const p = this.masker.unmask(value, maskResult.variables, maskResult.tagAttributes, this.config.locale, originalText, 'placeholder');
        placeholderOutput = maskResult.leadingWhitespace + this.masker.applyCasePattern(p, casePattern) + maskResult.trailingWhitespace;
      }
      this.morphInto(element, output, value, maskResult.variables, placeholderOutput);
      // Record the canonical serialization, which is what mutation callbacks
      // will echo back
      this.lastApplied.set(element, this.serializeAggregate(element));
    } else if (textNode) {
      // Node-scoped unit: write only this Text node, leaving the element's other units
      // (and their nodes) alone.
      this.setTextData(textNode, output);
      this.textUnits.set(textNode, { original: originalText, lastApplied: output });
    } else {
      this.setLeafText(element, output);
      this.lastApplied.set(element, output);
    }

    if (textNode) this.syncOriginalAttribute(element);
    else element.setAttribute(this.config.originalAttribute, originalText);
    element.removeAttribute(this.config.pendingAttribute);
    this.recordAppliedOutput(textNode ? output : this.lastApplied.get(element)!, originalText);
  }

  /**
   * The only place a Text node's data is written. Keeps {@link emptiedByUs} in step with
   * it, so a node we blank stays ours and a node we fill stops being a candidate.
   */
  private setTextData(node: Text, data: string): void {
    if (node.data !== data) node.data = data;
    if (data === '') this.emptiedByUs.add(node);
    else this.emptiedByUs.delete(node);
  }

  /** The only place a Text node is created; an empty one is ours, not a framework anchor. */
  private createText(doc: Document, data: string): Text {
    const node = doc.createTextNode(data);
    if (data === '') this.emptiedByUs.add(node);
    return node;
  }

  /**
   * An empty Text node is never *source* content — the Observer only collects text that
   * survives `.trim()`, and an HTML parser never emits a zero-length Text node. It is,
   * however, exactly what Vue (`hostCreateText('')`) and Svelte use to anchor a fragment:
   * the pair brackets the fragment's children, and `removeFragment` walks `nextSibling`
   * from the start anchor until it reaches the end one. Consume such a node as content —
   * reuse it, reorder across it, or reclaim it — and that walk runs off the end of the
   * child list into `null.nextSibling`. So they are treated as structural: never pooled,
   * never moved, never removed.
   *
   * The one empty Text node that is NOT an anchor is one we emptied ourselves (an ICU arm
   * rendered nothing). `data === ''` can't tell the two apart, so ownership is tracked
   * rather than inferred — which is the whole reason every write funnels through
   * {@link setTextData}.
   */
  private isAnchorText(node: Node): boolean {
    return node.nodeType === Node.TEXT_NODE && (node as Text).data === '' && !this.emptiedByUs.has(node as Text);
  }

  /**
   * Is `node` a live child that the translated output does not account for and that the
   * framework may own? Anchor comments, empty-Text fragment anchors and framework-rendered
   * elements are: they must keep both their identity and their position. The only
   * unaccounted-for child that is ours to reclaim is a stale content Text node.
   *
   * `accountedFor` says which live nodes the output already claims, and is what differs
   * between the two writers: the reconcile claims every node it reused, the rebuild claims
   * only the comments it reproduces (it recreates elements and text by definition).
   */
  private isStructuralChild(node: Node, accountedFor: (node: Node) => boolean): boolean {
    return !accountedFor(node) && (node.nodeType !== Node.TEXT_NODE || this.isAnchorText(node));
  }

  /**
   * Set a leaf element's visible text in place (node-preservation invariant). A leaf has
   * no element children, but it can still hold framework-owned structural nodes — a
   * `<!--v-if-->` placeholder, a fragment's empty-Text anchors — alongside its text.
   * `textContent =` would destroy those, so instead rewrite the first content-bearing
   * Text node in place (keeping its position) and reclaim only the other content Text
   * nodes. When there is no text to reuse, append one rather than clearing the element.
   */
  private setLeafText(element: Element, text: string): void {
    let target: Text | null = null;
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType !== Node.TEXT_NODE || this.isAnchorText(child)) continue;
      if (target === null) target = child as Text;
      else element.removeChild(child);
    }
    if (target) {
      this.setTextData(target, text);
    } else {
      element.appendChild(this.createText(element.ownerDocument, text));
    }
  }

  /**
   * Restore an aggregated element's original markup on the revert path.
   * Re-masks the stored canonical original to recover the same markers/variables
   * the apply-side morph used, then drives {@link morphInto} with the original as
   * the target output.
   */
  private morphOriginalInto(element: Element, originalText: string): void {
    const maskResult = this.masker.mask(originalText);
    let placeholderOutput: string | undefined;
    if (maskResult.variables.some((v) => v.type === 'ignored')) {
      placeholderOutput = this.masker.unmask(
        maskResult.masked,
        maskResult.variables,
        maskResult.tagAttributes,
        this.config.locale,
        originalText,
        'placeholder'
      );
    }
    // Stored original carries aggregation sentinels around ignored subtrees;
    // strip them back to clean markup for the rendered (non-placeholder) output.
    this.morphInto(element, stripIgnoreSentinels(originalText), maskResult.masked, maskResult.variables, placeholderOutput);
  }

  /**
   * Write translated HTML into `element` (node-preservation invariant). The common
   * case reconciles the output onto the existing nodes in place
   * ({@link reconcileChildren}): each inline `<tagN>` marker and each ignored slot
   * maps back to its live node, and only surrounding/inner Text data is rewritten —
   * text is never merged across an element boundary. When the output can't be
   * matched 1:1 (ICU branch selection, or a tag the translation added/dropped) it
   * falls back to {@link rebuildChildren}.
   */
  private morphInto(
    element: Element,
    output: string,
    maskedValue: string,
    variables: VariableInfo[] = [],
    placeholderOutput?: string
  ): void {
    const hasIgnored = placeholderOutput !== undefined;
    const fragment = this.parseFragment(hasIgnored ? placeholderOutput : output);

    // ICU branch selection picks one arm at eval time, so the markers (present in
    // every arm) can't be mapped 1:1 to the evaluated output — not reconcilable.
    if (ICU_PATTERN.test(maskedValue)) {
      this.rebuildChildren(element, fragment, variables, hasIgnored);
      return;
    }

    // Opening markers in document order, e.g. ["a0", "span1"]. Closing markers
    // (</a0>) and variable masks ({{0}}) don't match this and are ignored.
    const markers: string[] = [];
    const markerRe = /<(\w+?)(\d+)>/g;
    let match: RegExpExecArray | null;
    while ((match = markerRe.exec(maskedValue)) !== null) {
      markers.push(`${match[1]}${match[2]}`);
    }

    // Ignored subtrees ride through as opaque `<i18n-ignored>` placeholders; keep
    // them out of marker matching (they aren't tags the Masker numbered) — the
    // reconcile swaps them for live nodes by their own index.
    const outElements = Array.from(fragment.querySelectorAll('*')).filter(
      (e) => e.tagName.toLowerCase() !== IGNORED_PLACEHOLDER_TAG
    );

    // unmask preserves tree shape, so the k-th output element lines up with the
    // k-th opening marker. If the counts don't match, the shape changed and we
    // can't map reliably — fall back to a wholesale rebuild (correct output, but
    // it loses child-node identity).
    if (outElements.length !== markers.length) {
      this.rebuildChildren(element, fragment, variables, hasIgnored);
      return;
    }

    // Zip fragment elements to their marker (document order) so the reconcile can
    // resolve each translated element to the live node that marker points to.
    const elementMarker = new Map<Element, string>();
    for (let k = 0; k < outElements.length; k++) {
      elementMarker.set(outElements[k]!, markers[k]!);
    }
    const markerToNode = this.buildMarkerToNode(element);
    const liveIgnored = hasIgnored ? collectTopLevelIgnored(element, this.ignorePredicate) : [];
    const ignoredValues = hasIgnored ? variables.filter((v) => v.type === 'ignored').map((v) => v.value) : [];

    this.reconcileChildren(element, fragment.childNodes, elementMarker, markerToNode, liveIgnored, ignoredValues);
  }

  /**
   * Transform `liveParent`'s children into `templateNodes` in place (node-
   * preservation invariant), reusing existing nodes:
   *  - a Text node updates the next existing Text node's `.data` (drawn from a
   *    per-parent pool, in order); adjacent text never fuses across an element
   *    boundary;
   *  - an inline `<tagN>` marker element reuses the live node the marker points to
   *    and recurses into it;
   *  - an `<i18n-ignored>` placeholder reuses the live ignored node in place;
   *  - only a tag with no live counterpart (introduced by the translation) or a
   *    dropped ignored node is materialized fresh.
   * Then {@link arrangeChildren} orders `liveParent`'s children to match, moving
   * (never rebuilding) reused nodes and removing only genuinely stale ones. Idempotent:
   * re-running on already-applied content resolves to the same nodes and is a no-op.
   */
  private reconcileChildren(
    liveParent: Element,
    templateNodes: ArrayLike<Node>,
    elementMarker: Map<Element, string>,
    markerToNode: Map<string, Element>,
    liveIgnored: Element[],
    ignoredValues: string[]
  ): void {
    const doc = liveParent.ownerDocument;
    // Reusable existing Text / Comment nodes. Text is consumed in document order.
    // Comments are matched by DATA, never by position: a round-tripped comment (masked
    // as a variable) must reuse the live comment that actually carries its data, or a
    // framework anchor comment sitting earlier in the child list gets claimed for it and
    // dragged out of place. An unmatched live comment stays where it is. Empty Text nodes
    // are framework fragment anchors, not content ({@link isAnchorText}) — pooling one
    // would write translated data into it and strand the real text node as a leftover.
    const textPool: Text[] = [];
    const commentPool: Comment[] = [];
    for (const child of liveParent.childNodes) {
      if (this.isAnchorText(child)) continue;
      if (child.nodeType === Node.TEXT_NODE) textPool.push(child as Text);
      else if (child.nodeType === Node.COMMENT_NODE) commentPool.push(child as Comment);
    }
    let textIdx = 0;
    const takeComment = (data: string): Comment | undefined => {
      const i = commentPool.findIndex((c) => c.data === data);
      return i === -1 ? undefined : commentPool.splice(i, 1)[0];
    };

    const ordered: Node[] = [];

    for (const t of Array.from(templateNodes)) {
      if (t.nodeType === Node.TEXT_NODE) {
        const data = (t as Text).data;
        const reused = textPool[textIdx++];
        if (reused) {
          this.setTextData(reused, data);
          ordered.push(reused);
        } else {
          ordered.push(this.createText(doc, data));
        }
        continue;
      }

      if (t.nodeType !== Node.ELEMENT_NODE) {
        // The only non-text, non-element node an HTML fragment yields is a comment, and
        // comments round-trip verbatim (masked as a variable), so the live comment with
        // the same data is the one this node came from — reuse it, never clobbering any
        // comment's data. A comment with no live counterpart is carried through as the
        // parsed node.
        ordered.push(takeComment((t as Comment).data) ?? t);
        continue;
      }

      const te = t as Element;

      if (te.tagName.toLowerCase() === IGNORED_PLACEHOLDER_TAG) {
        const k = parseInt(te.getAttribute('data-k') ?? '', 10);
        const liveNode = Number.isNaN(k) ? undefined : liveIgnored[k];
        if (liveNode) {
          ordered.push(liveNode);
        } else {
          // No live counterpart survived — reconstruct from the verbatim masked markup.
          const rebuilt = this.parseFragment(ignoredValues[k] ?? '');
          for (const rn of Array.from(rebuilt.childNodes)) ordered.push(rn);
        }
        continue;
      }

      // Every non-placeholder fragment element was zipped into `elementMarker`
      // above, and — because unmask only re-emits tags the Masker numbered from
      // the source — the marker always resolves to a live node of the same tag
      // (marker/count mismatches took the rebuild fallback in morphInto). So the
      // reconcile path always reuses the live node in place; strip inline
      // event-handler attributes to match unmask's sanitization.
      const marker = elementMarker.get(te)!;
      const liveNode = markerToNode.get(marker)!;
      for (const name of liveNode.getAttributeNames()) {
        if (name.toLowerCase().startsWith('on')) liveNode.removeAttribute(name);
      }
      this.reconcileChildren(liveNode, te.childNodes, elementMarker, markerToNode, liveIgnored, ignoredValues);
      this.nodeMarkers.set(liveNode, marker);
      ordered.push(liveNode);
    }

    this.arrangeChildren(liveParent, ordered);
  }

  /**
   * Reorders `parent`'s children so they equal `ordered` (a sequence of nodes that
   * are already children of `parent`, plus any freshly-created ones), moving reused
   * nodes rather than recreating them and removing only the leftovers not in
   * `ordered`. When `ordered` already matches the current children this performs no
   * DOM writes, keeping re-application idempotent.
   */
  private arrangeChildren(parent: Element, ordered: Node[]): void {
    const claimed = new Set(ordered);
    const isStructural = (node: Node): boolean => this.isStructuralChild(node, (n) => claimed.has(n));

    let cursor: Node | null = parent.firstChild;
    for (const node of ordered) {
      // Step over structural children rather than matching against them: insertBefore on
      // one would push it to the end of the child list — an anchor comment away from the
      // branch it marks, a fragment anchor out of its [start, end] bracket.
      while (cursor && isStructural(cursor)) cursor = cursor.nextSibling;
      if (node === cursor) {
        cursor = cursor.nextSibling;
      } else {
        parent.insertBefore(node, cursor); // moves an existing child, or inserts a new one
      }
    }
    while (cursor) {
      const next = cursor.nextSibling;
      // Reclaim only stale Text nodes that carried content; leave the structural ones.
      if (!isStructural(cursor)) parent.removeChild(cursor);
      cursor = next;
    }
  }

  /**
   * The sanctioned exception to the node-preservation invariant: wholesale-replace
   * `element`'s children with `fragment`. Runs only when a 1:1 reconcile is
   * impossible (ICU branch selection or a tag-set change), so there is no stable
   * node to preserve; the written output is still correct. Live ignored nodes, when
   * present, are spliced back in first so at least those keep their identity.
   */
  private rebuildChildren(
    element: Element,
    fragment: DocumentFragment,
    variables: VariableInfo[],
    hasIgnored: boolean
  ): void {
    // Identity loss is sanctioned for content, never for the framework's structural
    // children: detach them with the rest, then thread them back at the same offset
    // among the new content. `replaceChildren` doesn't create nodes, so the ones we
    // re-insert are the very nodes the framework still holds references to.
    const structural = this.collectStructuralChildren(element, fragment);
    if (hasIgnored) this.restoreIgnoredNodes(element, fragment, variables);
    const content = Array.from(fragment.childNodes);
    element.replaceChildren(...content);
    for (const { node, anchorTo } of structural) {
      element.insertBefore(node, anchorTo === null ? null : content[anchorTo] ?? null);
    }
  }

  /**
   * The structural children of `element` that `fragment` does not reproduce, each tagged
   * with the content child it should precede (`null` = the end) — enough to restore its
   * position once the content is swapped out. A live comment is reproduced when the
   * fragment carries a comment with the same data (comments round-trip verbatim); the
   * rest, notably the framework's own anchors, are not, so they must survive the rebuild.
   */
  private collectStructuralChildren(element: Element, fragment: DocumentFragment): Array<{ node: Node; anchorTo: number | null }> {
    const reproduced = new Map<string, number>();
    for (const n of fragment.childNodes) {
      if (n.nodeType !== Node.COMMENT_NODE) continue;
      const { data } = n as Comment;
      reproduced.set(data, (reproduced.get(data) ?? 0) + 1);
    }
    const accountedFor = (node: Node): boolean => {
      if (node.nodeType !== Node.COMMENT_NODE) return !this.isAnchorText(node); // content is recreated
      const left = reproduced.get((node as Comment).data) ?? 0;
      if (left === 0) return false;
      reproduced.set((node as Comment).data, left - 1);
      return true;
    };

    const found: Array<{ node: Node; contentBefore: number }> = [];
    let contentBefore = 0;
    for (const child of element.childNodes) {
      if (this.isStructuralChild(child, accountedFor)) found.push({ node: child, contentBefore });
      else contentBefore++;
    }
    // A child that trailed all the content still trails it, however much the translation
    // grew or shrank the content — pin it to the end rather than to a now-stale index.
    return found.map(({ node, contentBefore: n }) => ({ node, anchorTo: n === contentBefore ? null : n }));
  }

  private parseFragment(html: string): DocumentFragment {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
  }

  /**
   * Replaces each `<i18n-ignored data-k>` placeholder in `fragment` with the
   * corresponding live ignored DOM node from `element` (node-preservation
   * invariant). When no live node survives, reconstruct the subtree from the
   * masked variable's verbatim markup so the output is still correct.
   */
  private restoreIgnoredNodes(element: Element, fragment: DocumentFragment, variables: VariableInfo[]): void {
    const live = collectTopLevelIgnored(element, this.ignorePredicate);
    const ignoredValues = variables.filter((v) => v.type === 'ignored').map((v) => v.value);
    const placeholders = fragment.querySelectorAll(IGNORED_PLACEHOLDER_TAG);
    for (const placeholder of placeholders) {
      const k = parseInt(placeholder.getAttribute('data-k') ?? '', 10);
      const liveNode = Number.isNaN(k) ? undefined : live[k];
      if (liveNode) {
        placeholder.replaceWith(liveNode);
      } else {
        const rebuilt = this.parseFragment(ignoredValues[k] ?? '');
        placeholder.replaceWith(...Array.from(rebuilt.childNodes));
      }
    }
  }

  /**
   * Map each inline-tag marker ("a0", "span1", …) to the live element it refers
   * to within `element`. On the first apply the subtree is the source, so we
   * reproduce the Masker's per-tag-name, 0-based, document-order numbering. Once
   * a subtree has been morphed its elements carry a recorded marker (nodeMarkers),
   * which we trust on re-translate so reordered/duplicate tags still map correctly.
   */
  private buildMarkerToNode(element: Element): Map<string, Element> {
    const elements: Element[] = [];
    const collect = (parent: Element): void => {
      for (const child of parent.children) {
        // Skip ignored subtrees: the Masker never numbered them as inline
        // markers (they're opaque variables), so counting them here would
        // shift every real marker's index.
        if (isIgnoredElement(child, this.ignorePredicate)) continue;
        elements.push(child);
        collect(child);
      }
    };
    collect(element);

    const map = new Map<string, Element>();
    if (elements.length > 0 && elements.every((e) => this.nodeMarkers.has(e))) {
      for (const e of elements) map.set(this.nodeMarkers.get(e)!, e);
    } else {
      const counters = new Map<string, number>();
      for (const e of elements) {
        const tag = e.tagName.toLowerCase();
        const n = counters.get(tag) ?? 0;
        counters.set(tag, n + 1);
        map.set(`${tag}${n}`, e);
      }
    }
    return map;
  }

  /** Unmasks and writes a translated attribute value, recording what was written. */
  private applyAttributeTranslation(
    element: Element,
    attr: string,
    value: string,
    maskResult: Pick<MaskResult, 'variables' | 'tagAttributes' | 'casePattern' | 'leadingWhitespace' | 'trailingWhitespace'>,
    originalValue: string
  ): void {
    const unmasked = this.masker.unmask(value, maskResult.variables, maskResult.tagAttributes, this.config.locale, originalValue);
    const output = maskResult.leadingWhitespace + this.masker.applyCasePattern(unmasked, maskResult.casePattern) + maskResult.trailingWhitespace;
    element.setAttribute(attr, output);

    this.attrMapFor(element).set(attr, output);
    this.recordAppliedOutput(output, originalValue);
  }

  /** Lazily-created per-element map of attr name -> last output we wrote for it. */
  private attrMapFor(element: Element): Map<string, string> {
    let applied = this.lastAppliedAttrs.get(element);
    if (!applied) {
      applied = new Map();
      this.lastAppliedAttrs.set(element, applied);
    }
    return applied;
  }

  /**
   * Index a concrete output string we just wrote to the DOM under the current
   * locale, keyed by its normalized (masked) form so the echo guard in
   * processText/processAttribute recognizes it regardless of the element it lands
   * on or trailing/collapsed whitespace. See {@link appliedOutputs}.
   */
  private recordAppliedOutput(concreteOutput: string, sourceOriginal: string): void {
    const normalized = this.masker.mask(concreteOutput).masked;
    let map = this.appliedOutputs.get(this.config.locale);
    if (!map) {
      map = new Map();
      this.appliedOutputs.set(this.config.locale, map);
    }
    map.set(normalized, sourceOriginal);
  }

  private trackPendingNode(
    cacheKey: string,
    element: Element,
    maskResult: MaskResult,
    originalText: string,
    isHtml: boolean,
    scope?: string,
    textNode?: Text
  ): void {
    this.addToPendingSet(cacheKey, {
      element,
      variables: maskResult.variables,
      tagAttributes: maskResult.tagAttributes,
      casePattern: maskResult.casePattern,
      leadingWhitespace: maskResult.leadingWhitespace,
      trailingWhitespace: maskResult.trailingWhitespace,
      originalText,
      snapshot: textNode ? textNode.data : this.currentContent(element, isHtml),
      isHtml,
      scope,
      textNode,
    });
  }

  private addToPendingSet(cacheKey: string, node: PendingNode): void {
    let set = this.pendingNodes.get(cacheKey);
    if (!set) {
      set = new Set();
      this.pendingNodes.set(cacheKey, set);
    }
    set.add(node);
  }

  private buildItem(
    cacheKey: string,
    originalText: string,
    variables: VariableInfo[],
    element: Element,
    source: TranslationItemDebug['source'],
    scope?: string
  ): TranslationItem {
    const item: TranslationItem = {
      masked: cacheKey,
      // Strip aggregation sentinels so the reported source is clean, human-
      // readable markup (the opaque regions are represented by the variables).
      original: stripIgnoreSentinels(originalText),
      variables,
    };
    if (scope) {
      item.scope = scope;
    }
    if (this.config.debug) {
      item.debug = this.collectDebugInfo(element, source);
    }
    return item;
  }

  private collectDebugInfo(
    element: Element,
    source: TranslationItemDebug['source']
  ): TranslationItemDebug {
    const childElements: TranslationItemDebug['childElements'] = [];
    for (const child of element.children) {
      childElements.push({
        tag: child.tagName,
        classes: child.className,
      });
    }

    // Extract just the opening tag from outerHTML
    const outer = element.outerHTML;
    const closeIdx = outer.indexOf('>');
    const elementOpenTag = closeIdx !== -1 ? outer.slice(0, closeIdx + 1) : outer;

    return { elementOpenTag, childElements, source };
  }
}

/** Returns true if the masked text contains letters to translate (not just placeholders, tags, whitespace, or punctuation). */
function hasTranslatableContent(masked: string): boolean {
  const stripped = masked.replace(/\{\{\d+\}\}/g, '').replace(/<[^>]*>/g, '');
  return /\p{L}/u.test(stripped);
}

/** Resolves a TranslationEntry to a string given an optional scope. */
function resolveEntry(value: TranslationEntry, scope?: string): string | undefined {
  if (typeof value === 'string') return value;
  if (scope && scope in value) return value[scope];
  return undefined;
}
