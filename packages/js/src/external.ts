import type { ExternalTranslatorSignal } from './types';

// Built-in translator signals — pure data; the detector engine below is generic,
// so supporting another translator means appending one entry (or passing
// `extraTranslatorSignals`), never touching engine code. Translators with no DOM
// footprint (Safari, DeepL) are accepted residual risk: their junk stays visible
// in reports by design, rather than being guessed at with language filtering.
export const EXTERNAL_TRANSLATOR_SIGNALS: ExternalTranslatorSignal[] = [
  // Chrome stamps these on <html> when it engages and removes them on
  // "Show original" — the one signal that toggles off again.
  { id: 'chrome-translate', rootClasses: ['translated-ltr', 'translated-rtl'], sticky: false },
  // Edge stamps proprietary attributes on elements it rewrites (see
  // dotnet/aspnetcore#47111); no reliable off-signal exists, so sticky.
  {
    id: 'edge-translate',
    mutationAttributes: ['_msttexthash', '_mstmutation', '_istranslated', '_msthash'],
    sticky: true,
  },
  // Immersive Translate APPENDS target-language nodes below the originals;
  // without this signal they would be collected as missing source strings.
  {
    id: 'immersive-translate',
    insertedNodeSelector:
      '.immersive-translate-target-wrapper, .immersive-translate-target-inner, [data-immersive-translate-translation-element-mark]',
    sticky: true,
  },
];

export interface ExternalTranslationDetectorConfig {
  signals: ExternalTranslatorSignal[];
  /** Fired on the inactive → active transition (any first signal). */
  onActivate: () => void;
}

/**
 * Tracks whether an external page translator is rewriting the page by evaluating
 * declarative signals: the Observer's existing mutation stream (attribute names,
 * added nodes) plus one class-attribute observer on the root element. A one-time
 * presence sweep catches a translator that engaged before start(); it is deferred
 * to a microtask to stay off the synchronous start path, which is safe because
 * nothing flushes before the debounce window and activation drops the queue.
 */
export class ExternalTranslationDetector {
  private rootSignals: ExternalTranslatorSignal[] = [];
  private nodeSignals: ExternalTranslatorSignal[] = [];
  /** Attribute name → the signal it belongs to. */
  private attributeSignals = new Map<string, ExternalTranslatorSignal>();
  private active = new Set<string>();
  private rootObserver: MutationObserver | null = null;
  private started = false;
  private onActivate: () => void;

  constructor(config: ExternalTranslationDetectorConfig) {
    this.onActivate = config.onActivate;
    for (const signal of config.signals) {
      if (signal.rootClasses?.length) this.rootSignals.push(signal);
      if (signal.insertedNodeSelector) this.nodeSignals.push(signal);
      for (const attr of signal.mutationAttributes ?? []) {
        this.attributeSignals.set(attr, signal);
      }
    }
  }

  /** True while any signal is active — the page is (or sticky-was) externally translated. */
  get isActive(): boolean {
    return this.active.size > 0;
  }

  /** Ids of the currently firing signals, for diagnostics. */
  get activeSignals(): string[] {
    return [...this.active];
  }

  /** Attribute names the main observer must add to its filter for us to see them. */
  get observedAttributes(): string[] {
    return [...this.attributeSignals.keys()];
  }

  start(): void {
    this.started = true;
    if (this.rootSignals.length > 0) {
      this.evaluateRootClasses();
      this.rootObserver = new MutationObserver(() => this.evaluateRootClasses());
      this.rootObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }
    queueMicrotask(() => this.sweepExisting());
  }

  stop(): void {
    this.started = false;
    if (this.rootObserver) {
      this.rootObserver.disconnect();
      this.rootObserver = null;
    }
    // `active` is deliberately kept: sticky signals hold for the session, and
    // root-class signals are re-evaluated on the next start().
  }

  // Per-record cost: a map lookup for attributes; for added elements, a
  // matches()/querySelector() only while a node signal is still inactive.
  evaluateMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const signal = mutation.attributeName
          ? this.attributeSignals.get(mutation.attributeName)
          : undefined;
        if (signal) this.activate(signal);
      } else if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          this.checkInsertedElement(node as Element);
        }
      }
    }
  }

  private checkInsertedElement(element: Element): void {
    for (const signal of this.nodeSignals) {
      if (this.active.has(signal.id)) continue;
      const selector = signal.insertedNodeSelector!;
      if (element.matches(selector) || element.querySelector(selector)) {
        this.activate(signal);
      }
    }
  }

  /** Presence check against the current DOM for indicators that predate start(). */
  private sweepExisting(): void {
    if (!this.started) return;
    for (const signal of this.nodeSignals) {
      if (!this.active.has(signal.id) && document.querySelector(signal.insertedNodeSelector!)) {
        this.activate(signal);
      }
    }
    for (const [attr, signal] of this.attributeSignals) {
      if (!this.active.has(signal.id) && document.querySelector(`[${attr}]`)) {
        this.activate(signal);
      }
    }
  }

  private evaluateRootClasses(): void {
    const classList = document.documentElement.classList;
    for (const signal of this.rootSignals) {
      const present = signal.rootClasses!.some((cls) => classList.contains(cls));
      if (present) {
        this.activate(signal);
      } else if (!signal.sticky) {
        this.active.delete(signal.id);
      }
    }
  }

  private activate(signal: ExternalTranslatorSignal): void {
    if (this.active.has(signal.id)) return;
    const wasActive = this.isActive;
    this.active.add(signal.id);
    if (!wasActive) this.onActivate();
  }
}
