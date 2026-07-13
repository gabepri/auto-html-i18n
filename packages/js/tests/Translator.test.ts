import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Translator, TranslatorConfig } from '../src/Translator';
import { Store } from '../src/Store';
import { Queue } from '../src/Queue';
import { Masker } from '../src/Masker';
import { serializeAggregate } from '../src/ignore';
import type { TranslationItem } from '../src/types';

const IGNORE_PREDICATE = { ignoreAttribute: 'data-i18n-ignore', ignoreSelectors: [] };

function createDeps(overrides: {
  storeOverrides?: Record<string, unknown>;
  configOverrides?: Partial<TranslatorConfig>;
} = {}) {
  const store = new Store();
  const onFlushFn = vi.fn<(items: TranslationItem[]) => Promise<void>>().mockResolvedValue(undefined);
  const queue = new Queue({
    debounceTime: 200,
    maxBatchSize: 50,
    onFlush: onFlushFn,
  });
  const masker = new Masker({
    ignoreWords: ['Mary', 'John'],
    allowedInlineTags: ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del'],
  });
  const onMissingTranslation = vi.fn().mockResolvedValue(null);
  const config: TranslatorConfig = {
    locale: 'es',
    originalAttribute: 'data-i18n-original',
    pendingAttribute: 'data-i18n-pending',
    keyAttribute: 'data-i18n-key',
    scopeAttribute: 'data-i18n-scope',
    translatableAttributes: ['title', 'placeholder', 'alt', 'aria-label'],
    onMissingTranslation,
    debug: false,
    ...overrides.configOverrides,
  };

  const translator = new Translator(store, queue, masker, config);
  return { translator, store, queue, masker, config, onMissingTranslation, onFlushFn };
}

describe('Translator', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  describe('processText() - sync path (cached)', () => {
    it('should apply cached string translation immediately', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(p.textContent).toBe('Hola');
    });

    it('updates the existing text node in place instead of replacing it (preserves node identity)', () => {
      // A leaf element's text node is often a framework's tracked vnode — e.g. the slot
      // text of a Vue <RouterLink>. Replacing it via `element.textContent = ...` removes
      // that node and creates a new one, orphaning the framework's reference; the crash
      // surfaces when the framework later unmounts the node (menu flyouts / navigation).
      // The apply must update the existing text node's data, not swap the node out.
      const { translator, store } = createDeps();
      store.set('es', 'Dashboard', 'Panel');

      const a = document.createElement('a');
      a.textContent = 'Dashboard';
      root.appendChild(a);
      const originalTextNode = a.firstChild;

      translator.processText(a, 'Dashboard');

      expect(a.textContent).toBe('Panel'); // translation applied
      expect(a.firstChild).toBe(originalTextNode); // same text node instance, not replaced
    });

    it('should unmask variables in cached translation', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello {{0}}', 'Hola {{0}}');

      const p = document.createElement('p');
      p.textContent = 'Hello Mary';
      root.appendChild(p);

      translator.processText(p, 'Hello Mary');

      expect(p.textContent).toBe('Hola Mary');
    });

    it('should set originalAttribute on the element', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(p.getAttribute('data-i18n-original')).toBe('Hello');
    });

    it('should not have pending attribute after sync translation', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
    });
  });

  describe('processText() - async path (uncached)', () => {
    it('should mark element as pending', () => {
      const { translator } = createDeps();

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(p.hasAttribute('data-i18n-pending')).toBe(true);
    });

    it('should enqueue the masked text in the queue', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('Hello');
    });

    it('should not enqueue if already pending in store', () => {
      const { translator, store, queue } = createDeps();
      store.markPending('es', 'Hello');
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(p.hasAttribute('data-i18n-pending')).toBe(true);
    });

    it('should apply translation when resolved via applyPending', () => {
      const { translator, store } = createDeps();

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');
      expect(p.hasAttribute('data-i18n-pending')).toBe(true);

      // Simulate translation result arriving
      store.set('es', 'Hello', 'Hola');
      translator.applyPending('Hello');

      expect(p.textContent).toBe('Hola');
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
      expect(p.getAttribute('data-i18n-original')).toBe('Hello');
    });
  });

  describe('processText() - with data-i18n-key', () => {
    it('should use keyAttribute value as cache key instead of masked text', () => {
      const { translator, store } = createDeps();
      store.set('es', 'custom.key', 'Texto personalizado');

      const span = document.createElement('span');
      span.setAttribute('data-i18n-key', 'custom.key');
      span.textContent = 'Some text';
      root.appendChild(span);

      translator.processText(span, 'Some text');

      expect(span.textContent).toBe('Texto personalizado');
    });
  });

  describe('processAttribute()', () => {
    it('should translate an attribute value (sync)', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Enter name', 'Ingrese nombre');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', 'Enter name');

      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');
    });

    it('should queue uncached attribute translations', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', 'Enter name');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it('should apply attribute translation when resolved', () => {
      const { translator, store } = createDeps();

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', 'Enter name');

      // Simulate translation result arriving
      store.set('es', 'Enter name', 'Ingrese nombre');
      translator.applyPending('Enter name');

      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');
    });
  });

  describe('processAttribute() - original tracking', () => {
    it('should set original-tracking attribute on sync translation', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Enter name', 'Ingrese nombre');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', 'Enter name');

      expect(input.getAttribute('data-i18n-original-placeholder')).toBe('Enter name');
    });

    it('should skip if original-tracking attribute already exists', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Ingrese nombre');
      input.setAttribute('data-i18n-original-placeholder', 'Enter name');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', 'Ingrese nombre');

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should set original-tracking attribute via applyPending', () => {
      const { translator, store } = createDeps();

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', 'Enter name');

      store.set('es', 'Enter name', 'Ingrese nombre');
      translator.applyPending('Enter name');

      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');
      expect(input.getAttribute('data-i18n-original-placeholder')).toBe('Enter name');
    });

    it('should track multiple attributes independently on same element', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Photo', 'Foto');
      store.set('es', 'My photo', 'Mi foto');

      const img = document.createElement('img');
      img.setAttribute('alt', 'Photo');
      img.setAttribute('title', 'My photo');
      root.appendChild(img);

      translator.processAttribute(img, 'alt', 'Photo');
      translator.processAttribute(img, 'title', 'My photo');

      expect(img.getAttribute('data-i18n-original-alt')).toBe('Photo');
      expect(img.getAttribute('data-i18n-original-title')).toBe('My photo');
    });
  });

  describe('retranslateAll()', () => {
    it('should re-translate all elements with originalAttribute', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');
      expect(p.textContent).toBe('Hola');

      // Verify retranslateAll re-processes nodes
      translator.retranslateAll();
      expect(p.textContent).toBe('Hola');
    });

    it('should re-translate attributes with original-tracking data', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Enter name', 'Ingrese nombre');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Ingrese su nombre');
      input.setAttribute('data-i18n-original-placeholder', 'Enter name');
      root.appendChild(input);

      translator.retranslateAll();

      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');
    });

    it('should queue attributes for uncached locale on retranslateAll', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Ingrese nombre');
      input.setAttribute('data-i18n-original-placeholder', 'Enter name');
      root.appendChild(input);

      translator.setLocale('fr');
      translator.retranslateAll();

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('Enter name');
    });
  });

  describe('setLocale()', () => {
    it('should update the internal locale', () => {
      const { translator } = createDeps();
      expect(translator.locale).toBe('es');

      translator.setLocale('fr');
      expect(translator.locale).toBe('fr');
    });
  });

  describe('inline HTML translation', () => {
    it('should handle innerHTML with inline tags', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Click <a0>here</a0> to login', 'Haga clic <a0>aqui</a0> para iniciar');

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/login">here</a> to login';
      root.appendChild(p);

      translator.processText(p, 'Click <a href="/login">here</a> to login');

      expect(p.innerHTML).toBe('Haga clic <a href="/login">aqui</a> para iniciar');
    });

    it('should strip event handlers from restored attributes', () => {
      const { translator, store } = createDeps();
      // Masker would normally strip these, but let's test the unmask path
      store.set('es', 'Click <a0>here</a0>', 'Clic <a0>aqui</a0>');

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/ok" onclick="alert(1)">here</a>';
      root.appendChild(p);

      translator.processText(p, 'Click <a href="/ok" onclick="alert(1)">here</a>');

      expect(p.innerHTML).toContain('href="/ok"');
      expect(p.innerHTML).not.toContain('onclick');
    });
  });

  describe('inline HTML translation - node preservation (morph)', () => {
    it('reuses the original child element instance (and its listeners) on apply', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Click <a0>here</a0> to continue', 'Haga clic <a0>aqui</a0> para continuar');

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/x">here</a> to continue';
      root.appendChild(p);
      const originalAnchor = p.querySelector('a')!;
      let clicked = 0;
      originalAnchor.addEventListener('click', () => { clicked++; });

      translator.processText(p, 'Click <a href="/x">here</a> to continue');

      const afterAnchor = p.querySelector('a')!;
      expect(afterAnchor).toBe(originalAnchor); // same node instance, not recreated
      expect(afterAnchor.getAttribute('href')).toBe('/x');
      expect(afterAnchor.textContent).toBe('aqui');
      afterAnchor.dispatchEvent(new Event('click'));
      expect(clicked).toBe(1); // listener survived the translation
      expect(p.innerHTML).toBe('Haga clic <a href="/x">aqui</a> para continuar');
    });

    it('preserves instances when the translation reorders inline tags', () => {
      const { translator, store } = createDeps();
      store.set('es', '<a0>first</a0> and <b0>second</b0>', '<b0>segundo</b0> y <a0>primero</a0>');

      const p = document.createElement('p');
      p.innerHTML = '<a href="/1">first</a> and <b>second</b>';
      root.appendChild(p);
      const a = p.querySelector('a')!;
      const b = p.querySelector('b')!;

      translator.processText(p, '<a href="/1">first</a> and <b>second</b>');

      expect(p.querySelector('a')).toBe(a);
      expect(p.querySelector('b')).toBe(b);
      expect(a.textContent).toBe('primero');
      expect(b.textContent).toBe('segundo');
      expect(p.innerHTML).toBe('<b>segundo</b> y <a href="/1">primero</a>');
    });

    it('preserves a framework anchor comment interleaved in the aggregate (does not remove it)', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Click <a0>here</a0> to continue', 'Haga clic <a0>aqui</a0> para continuar');

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/x">here</a> to continue';
      // A framework (Vue) fragment / v-if anchor lives among the children. The reconcile
      // must never remove it: a node the framework still references, once detached, breaks
      // its vdom<->DOM linkage and crashes its next patch/unmount (Vue: removeFragment /
      // unmountComponent dereference null walking the orphaned sibling chain).
      const frameworkAnchor = document.createComment('v-if');
      p.appendChild(frameworkAnchor);
      root.appendChild(p);

      translator.processText(p, 'Click <a href="/x">here</a> to continue');

      // Translation still applied...
      expect(p.querySelector('a')!.textContent).toBe('aqui');
      // ...and the anchor comment survived — same instance, still parented to p.
      expect(frameworkAnchor.parentNode).toBe(p);
      expect(Array.from(p.childNodes)).toContain(frameworkAnchor);
    });

    it('reuses the node but still strips its event-handler attributes', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Click <a0>here</a0>', 'Clic <a0>aqui</a0>');

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/ok" onclick="alert(1)">here</a>';
      root.appendChild(p);
      const anchor = p.querySelector('a')!;

      translator.processText(p, 'Click <a href="/ok" onclick="alert(1)">here</a>');

      expect(p.querySelector('a')).toBe(anchor); // same instance
      expect(anchor.getAttribute('href')).toBe('/ok');
      expect(anchor.hasAttribute('onclick')).toBe(false); // handler attr stripped
      expect(p.innerHTML).toBe('Clic <a href="/ok">aqui</a>');
    });

    it('preserves the anchor instance across a re-translate (locale switch)', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Click <a0>here</a0>', 'Clic <a0>aqui</a0>');
      store.set('fr', 'Click <a0>here</a0>', 'Cliquez <a0>ici</a0>');

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/x">here</a>';
      root.appendChild(p);

      translator.processText(p, 'Click <a href="/x">here</a>');
      const anchor = p.querySelector('a')!;
      expect(anchor.textContent).toBe('aqui');

      translator.setLocale('fr');
      translator.retranslateAll();

      expect(p.querySelector('a')).toBe(anchor); // same instance across the switch
      expect(anchor.textContent).toBe('ici');
      expect(p.innerHTML).toBe('Cliquez <a href="/x">ici</a>');
    });

    it('falls back to a plain replace (output still correct) when the tag set changes', () => {
      const { translator, store } = createDeps();
      // Translation introduces a <b> the source never had — markers no longer
      // line up 1:1, so the morph bails to a correct innerHTML assignment.
      store.set('es', 'See <a0>docs</a0>', 'Ver <a0>docs</a0> <b>ahora</b>');

      const p = document.createElement('p');
      p.innerHTML = 'See <a href="/d">docs</a>';
      root.appendChild(p);

      translator.processText(p, 'See <a href="/d">docs</a>');

      expect(p.innerHTML).toBe('Ver <a href="/d">docs</a> <b>ahora</b>');
    });

    it('renders correctly (via fallback) for an ICU aggregated translation', () => {
      const { translator, store } = createDeps();
      // ICU selects one branch at eval time, so the morph can't match markers and
      // falls back — the evaluated output must still be written correctly.
      store.set('es', '<b0>{{0}}</b0> sheep', '{0, plural, one {<b0># oveja</b0>} other {<b0># ovejas</b0>}}');

      const p = document.createElement('p');
      p.innerHTML = '<b>5</b> sheep';
      root.appendChild(p);

      translator.processText(p, '<b>5</b> sheep');

      expect(p.innerHTML).toBe('<b>5 ovejas</b>');
    });
  });

  describe('inline HTML apply - non-destructive to child-node identity (framework safety)', () => {
    // An aggregation target can be a container that ALSO holds framework-managed
    // element children (a Vue/React router-link, a component root) plus its own
    // direct text. Recreating its children on apply (innerHTML/replaceChildren)
    // severs those nodes from the framework's vdom, which then dereferences null on
    // its next patch and crashes. The apply must reconcile in place instead.

    it('preserves the direct text node AND the child element node (with its listener) on apply', () => {
      const { translator, store } = createDeps();
      // Mirrors the reported case: direct text interleaved with a framework-owned link.
      store.set('es', 'Completado la semana pasada <a0>Reto</a0>', 'Completed last week <a0>Challenge</a0>');

      const div = document.createElement('div');
      div.innerHTML = 'Completado la semana pasada <a href="/x">Reto</a>';
      root.appendChild(div);

      const directText = div.firstChild!;        // the framework-owned direct text node
      const anchor = div.querySelector('a')!;     // the framework-owned link element
      const anchorText = anchor.firstChild!;      // the link's inner text node
      let clicked = 0;
      anchor.addEventListener('click', () => { clicked++; });

      translator.processText(div, 'Completado la semana pasada <a href="/x">Reto</a>');

      // Element identity + listener survive (already true before the fix)...
      expect(div.querySelector('a')).toBe(anchor);
      anchor.dispatchEvent(new Event('click'));
      expect(clicked).toBe(1);
      // ...and so do the surrounding/inner TEXT nodes (the regression: old apply
      // recreated these, orphaning the framework's references to them).
      expect(div.firstChild).toBe(directText);
      expect(directText.textContent).toBe('Completed last week ');
      expect(anchor.firstChild).toBe(anchorText);
      expect(anchorText.textContent).toBe('Challenge');
      expect(div.innerHTML).toBe('Completed last week <a href="/x">Challenge</a>');
    });

    it('does not fuse adjacent text into a reused element', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Foo <a0>Bar</a0> Baz', 'Uno <a0>Dos</a0> Tres');

      const p = document.createElement('p');
      p.innerHTML = 'Foo <a href="/x">Bar</a> Baz';
      root.appendChild(p);
      const anchor = p.querySelector('a')!;

      translator.processText(p, 'Foo <a href="/x">Bar</a> Baz');

      // <a> reused, and its siblings remain distinct Text nodes (no "…Dos" fusion).
      expect(p.querySelector('a')).toBe(anchor);
      expect(anchor.previousSibling!.nodeType).toBe(Node.TEXT_NODE);
      expect(anchor.nextSibling!.nodeType).toBe(Node.TEXT_NODE);
      expect(anchor.previousSibling!.textContent).toBe('Uno ');
      expect(anchor.nextSibling!.textContent).toBe(' Tres');
      expect(anchor.childNodes.length).toBe(1);
      expect(anchor.textContent).toBe('Dos');
      expect(p.innerHTML).toBe('Uno <a href="/x">Dos</a> Tres');
    });

    it('is idempotent: re-applying the same translation neither duplicates nor destroys nodes', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Completado <a0>Reto</a0>', 'Done <a0>Task</a0>');

      const div = document.createElement('div');
      div.innerHTML = 'Completado <a href="/x">Reto</a>';
      root.appendChild(div);

      translator.processText(div, 'Completado <a href="/x">Reto</a>');
      const anchor = div.querySelector('a')!;
      const directText = div.firstChild!;
      const childCount = div.childNodes.length;

      // A second apply (e.g. a re-fired MutationObserver / retranslate) must be a no-op.
      translator.retranslateAll();

      expect(div.childNodes.length).toBe(childCount);
      expect(div.querySelector('a')).toBe(anchor);
      expect(div.firstChild).toBe(directText);
      expect(div.innerHTML).toBe('Done <a href="/x">Task</a>');
    });

    it('preserves the live DOM node of an ignored child across apply', () => {
      const { translator, store } = createDeps({
        configOverrides: {
          serializeAggregate: (el) => serializeAggregate(el, IGNORE_PREDICATE),
          ignorePredicate: IGNORE_PREDICATE,
        },
      });
      // The ignored <span>'s user data is masked as one opaque {{0}} variable.
      store.set('es', 'Hola {{0}} mundo', 'Hello {{0}} world');

      const div = document.createElement('div');
      div.innerHTML = 'Hola <span data-i18n-ignore>Jdoe#42</span> mundo';
      root.appendChild(div);
      const ignored = div.querySelector('[data-i18n-ignore]')!;
      const ignoredText = ignored.firstChild!;

      translator.processText(div, serializeAggregate(div, IGNORE_PREDICATE));

      // The ignored subtree keeps its exact live node (and inner text), not a rebuild.
      expect(div.querySelector('[data-i18n-ignore]')).toBe(ignored);
      expect(ignored.firstChild).toBe(ignoredText);
      expect(ignored.textContent).toBe('Jdoe#42');
      expect(div.textContent).toBe('Hello Jdoe#42 world');
    });

    it('still maps <spanN> markers to reused children (structural-marker regression)', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Total <span0>{{0}}</span0> items', 'Total de <span0>{{0}}</span0> artículos');

      const p = document.createElement('p');
      p.innerHTML = 'Total <span class="count">5</span> items';
      root.appendChild(p);
      const span = p.querySelector('span')!;

      translator.processText(p, 'Total <span class="count">5</span> items');

      expect(p.querySelector('span')).toBe(span);           // reused, not rebuilt
      expect(span.getAttribute('class')).toBe('count');
      expect(span.textContent).toBe('5');
      expect(p.innerHTML).toBe('Total de <span class="count">5</span> artículos');
    });

    it('leaf text element still translates via in-place text update', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(p.childNodes.length).toBe(1);
      expect(p.firstChild!.nodeType).toBe(Node.TEXT_NODE);
      expect(p.textContent).toBe('Hola');
    });

    it('falls back to a documented rebuild (no silent corruption) when the tag set changes', () => {
      const { translator, store } = createDeps();
      // Translation introduces a <b> the source never had — not reconcilable 1:1.
      store.set('es', 'See <a0>docs</a0>', 'Ver <a0>docs</a0> <b>ahora</b>');

      const p = document.createElement('p');
      p.innerHTML = 'See <a href="/d">docs</a>';
      root.appendChild(p);
      const anchor = p.querySelector('a')!;

      translator.processText(p, 'See <a href="/d">docs</a>');

      // Output is still correct (the contract of the fallback); the <a> identity is
      // knowingly lost — this is the documented rebuild path, not a reconcile.
      expect(p.innerHTML).toBe('Ver <a href="/d">docs</a> <b>ahora</b>');
      expect(p.querySelector('a')).not.toBe(anchor);
    });

    it('materializes a text node the translation introduces between reused elements', () => {
      const { translator, store } = createDeps();
      store.set('es', '<a0>x</a0><b0>y</b0>', '<a0>x</a0> y <b0>z</b0>');

      const p = document.createElement('p');
      p.innerHTML = '<a href="/1">x</a><b>y</b>';
      root.appendChild(p);
      const a = p.querySelector('a')!;
      const b = p.querySelector('b')!;

      translator.processText(p, '<a href="/1">x</a><b>y</b>');

      expect(p.querySelector('a')).toBe(a);          // reused
      expect(p.querySelector('b')).toBe(b);          // reused
      expect(p.innerHTML).toBe('<a href="/1">x</a> y <b>z</b>');
    });

    it('removes now-stale nodes when the translation drops content between elements', () => {
      const { translator, store } = createDeps();
      store.set('es', '<a0>x</a0> <b0>y</b0>', '<a0>x</a0><b0>y</b0>');

      const p = document.createElement('p');
      p.innerHTML = '<a href="/1">x</a> <b>y</b>';
      root.appendChild(p);
      const a = p.querySelector('a')!;
      const b = p.querySelector('b')!;

      translator.processText(p, '<a href="/1">x</a> <b>y</b>');

      // The whitespace text node between them is gone; the elements are reused.
      expect(p.querySelector('a')).toBe(a);
      expect(p.querySelector('b')).toBe(b);
      expect(p.childNodes.length).toBe(2);
      expect(p.innerHTML).toBe('<a href="/1">x</a><b>y</b>');
    });

    it('carries a comment node through the reconcile', () => {
      const { translator, store } = createDeps();
      // The comment masks to an opaque variable and round-trips verbatim.
      store.set('es', 'Hi {{0}} <a0>x</a0>', 'Hola {{0}} <a0>x</a0>');

      const p = document.createElement('p');
      p.innerHTML = 'Hi <!--c--> <a href="/1">x</a>';
      root.appendChild(p);
      const a = p.querySelector('a')!;

      translator.processText(p, 'Hi <!--c--> <a href="/1">x</a>');

      expect(p.querySelector('a')).toBe(a);
      expect(p.innerHTML).toBe('Hola <!--c--> <a href="/1">x</a>');
    });

    it('materializes a round-tripped comment when no live comment survives to reuse', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hi {{0}} <a0>x</a0>', 'Hola {{0}} <a0>x</a0>');

      const p = document.createElement('p');
      p.innerHTML = 'Hi <!--c--> <a href="/1">x</a>';
      root.appendChild(p);
      // A framework dropped the comment node from the live DOM between collection
      // and apply. The translation still carries it (masked as a variable), so the
      // reconcile has no live comment to reuse and must carry the parsed one through.
      p.childNodes[1]!.remove();
      expect(p.innerHTML).toBe('Hi  <a href="/1">x</a>');

      translator.processText(p, 'Hi <!--c--> <a href="/1">x</a>');

      expect(p.innerHTML).toBe('Hola <!--c--> <a href="/1">x</a>');
    });

    it('reconstructs an ignored subtree from masked markup when its live node vanished', () => {
      const { translator, store } = createDeps({
        configOverrides: {
          serializeAggregate: (el) => serializeAggregate(el, IGNORE_PREDICATE),
          ignorePredicate: IGNORE_PREDICATE,
        },
      });
      store.set('es', 'Hola {{0}} mundo', 'Hello {{0}} world');

      const div = document.createElement('div');
      div.innerHTML = 'Hola <span data-i18n-ignore>secret</span> mundo';
      root.appendChild(div);

      // Capture the aggregated form, then drop the ignored node before apply so no
      // live node survives — the reconcile must rebuild it from the masked markup.
      const aggregated = serializeAggregate(div, IGNORE_PREDICATE);
      div.querySelector('[data-i18n-ignore]')!.remove();

      translator.processText(div, aggregated);

      const rebuilt = div.querySelector('[data-i18n-ignore]');
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.textContent).toBe('secret');
      expect(div.textContent).toBe('Hello secret world');
    });

    it('keeps the ignored live node even on the rebuild fallback (tag-set change)', () => {
      const { translator, store } = createDeps({
        configOverrides: {
          serializeAggregate: (el) => serializeAggregate(el, IGNORE_PREDICATE),
          ignorePredicate: IGNORE_PREDICATE,
        },
      });
      // Translation adds a <b> the source lacked → not reconcilable → rebuild path,
      // which still splices the live ignored node back in via restoreIgnoredNodes.
      store.set('es', 'Hola {{0}} <a0>link</a0>', 'Hola {{0}} <a0>link</a0> <b>extra</b>');

      const div = document.createElement('div');
      div.innerHTML = 'Hola <span data-i18n-ignore>secret</span> <a href="/x">link</a>';
      root.appendChild(div);
      const ignored = div.querySelector('[data-i18n-ignore]')!;

      translator.processText(div, serializeAggregate(div, IGNORE_PREDICATE));

      expect(div.querySelector('[data-i18n-ignore]')).toBe(ignored); // live node preserved
      expect(div.querySelector('b')!.textContent).toBe('extra');     // fallback output correct
    });

    // Vue (and Svelte) bracket a fragment — v-for output, a multi-root component — with a
    // pair of EMPTY Text nodes, and unmount it by walking `nextSibling` from the start
    // anchor to the end one. Consume either anchor as content and that walk runs off the
    // end of the child list, so the framework dereferences `null.nextSibling` on the next
    // unmount. An empty Text node is never source content (the Observer requires
    // non-whitespace, and a parser never emits one), so the reconcile steps over them.

    it('preserves a fragment\'s empty-Text anchors and does not reorder reused nodes across them', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Some text <span0>Item</span0>', 'Texto <span0>Elemento</span0>');

      const p = document.createElement('p');
      p.innerHTML = 'Some text <span>Item</span>';
      root.appendChild(p);
      // Bracket the <span> the way Vue brackets a v-for fragment's children.
      const span = p.querySelector('span')!;
      const startAnchor = document.createTextNode('');
      const endAnchor = document.createTextNode('');
      p.insertBefore(startAnchor, span);
      p.appendChild(endAnchor);
      const leadingText = p.firstChild!;

      translator.processText(p, 'Some text <span>Item</span>');

      // Both anchors survive, still empty, still bracketing the span in document order —
      // otherwise removeFragment(start, end) never reaches `end` and walks into null.
      expect(Array.from(p.childNodes)).toEqual([leadingText, startAnchor, span, endAnchor]);
      expect(startAnchor.data).toBe('');
      expect(endAnchor.data).toBe('');
      expect(p.querySelector('span')).toBe(span);
      // ...and the translation still applied.
      expect(leadingText.textContent).toBe('Texto ');
      expect(span.textContent).toBe('Elemento');
    });

    it('does not write translated text into a leading fragment anchor', () => {
      const { translator, store } = createDeps();
      store.set('es', '<span0>Item</span0> trailing', '<span0>Elemento</span0> final');

      const p = document.createElement('p');
      p.innerHTML = '<span>Item</span> trailing';
      root.appendChild(p);
      const span = p.querySelector('span')!;
      const startAnchor = document.createTextNode('');
      p.insertBefore(startAnchor, span);
      const trailingText = p.lastChild!;

      translator.processText(p, '<span>Item</span> trailing');

      // The anchor is the first Text child; pooling it would have taken the translated
      // trailing text and stranded the real Text node as a leftover to be reclaimed.
      expect(startAnchor.data).toBe('');
      expect(p.firstChild).toBe(startAnchor);
      expect(span.textContent).toBe('Elemento');
      expect(p.lastChild).toBe(trailingText);
      expect(trailingText.textContent).toBe(' final');
    });

    it('preserves a v-if comment anchor when setting a leaf\'s text', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Some text', 'Texto');

      // A leaf (no element children) can still hold a framework placeholder comment —
      // this is `<p>Some text <b v-if="flag">bold</b></p>` with flag false.
      const p = document.createElement('p');
      p.appendChild(document.createTextNode('Some text'));
      const comment = document.createComment('');
      p.appendChild(comment);
      root.appendChild(p);

      translator.processText(p, 'Some text');

      expect(p.childNodes.length).toBe(2);
      expect(p.firstChild!.textContent).toBe('Texto');
      expect(p.lastChild).toBe(comment); // `textContent =` would have destroyed it
    });

    it('sets text on a leaf that holds only an anchor, without clearing it', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Some text', 'Texto');

      const p = document.createElement('p');
      const comment = document.createComment('');
      p.appendChild(comment);
      root.appendChild(p);

      translator.processText(p, 'Some text');

      expect(p.textContent).toBe('Texto');
      expect(p.contains(comment)).toBe(true);
    });

    it('collapses a leaf\'s extra content Text nodes into the first, keeping structural nodes', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Some text', 'Texto');

      // A leaf can hold several content Text nodes split around a framework anchor.
      // The translation is one string, so the first node takes it (in place) and the
      // rest are reclaimed — but the anchor between them is not ours to remove.
      const p = document.createElement('p');
      const first = document.createTextNode('Some text');
      const anchor = document.createComment('v-if');
      const second = document.createTextNode(' leftover');
      p.append(first, anchor, second);
      root.appendChild(p);

      translator.processText(p, 'Some text');

      expect(Array.from(p.childNodes)).toEqual([first, anchor]);
      expect(first.data).toBe('Texto');   // rewritten in place, identity kept
      expect(second.parentNode).toBe(null); // stale content node reclaimed
    });

    // The two shapes observed crashing a real Vue app, both reached through the LEAF path
    // (no element child anywhere) rather than the aggregation path. A slot rendered through
    // nested fragments brackets its text with a pair of empty-Text anchors per level, so
    // `textContent =` on the leaf destroyed four of them in one write.

    it('preserves the anchors of nested fragments bracketing a leaf\'s text', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Preventive', 'Preventivo');

      const button = document.createElement('button');
      const outerStart = document.createTextNode('');
      const innerStart = document.createTextNode('');
      const text = document.createTextNode('Preventive');
      const innerEnd = document.createTextNode('');
      const outerEnd = document.createTextNode('');
      button.append(outerStart, innerStart, text, innerEnd, outerEnd);
      root.appendChild(button);

      translator.processText(button, 'Preventive');

      // Every anchor keeps its identity AND its position — removeFragment walks from each
      // start anchor to its end one, so a survivor in the wrong place is no better.
      expect(Array.from(button.childNodes)).toEqual([outerStart, innerStart, text, innerEnd, outerEnd]);
      expect(text.data).toBe('Preventivo'); // translated in place, original Text node reused
      expect(button.textContent).toBe('Preventivo');
    });

    it('preserves a fragment anchor and a v-if comment bracketing a leaf\'s text', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} of {{1}}', '{{0}} de {{1}}'); // the numbers mask to variables

      const span = document.createElement('span');
      const start = document.createTextNode('');
      const vIf = document.createComment('');
      const text = document.createTextNode('1 of 3');
      const end = document.createTextNode('');
      span.append(start, vIf, text, end);
      root.appendChild(span);

      translator.processText(span, '1 of 3');

      expect(Array.from(span.childNodes)).toEqual([start, vIf, text, end]);
      expect(start.data).toBe('');
      expect(end.data).toBe('');
      expect(text.data).toBe('1 de 3');
    });

    it('preserves fragment anchors through the rebuild fallback (ICU)', () => {
      const { translator, store } = createDeps();
      // ICU forces morphInto to bail to rebuildChildren, which replaces the children
      // wholesale. The anchors must still survive — a rebuild that drops them leaves
      // the framework walking nextSibling from a detached start anchor into null.
      store.set('es', '<b0>{{0}}</b0> sheep', '{0, plural, one {<b0># oveja</b0>} other {<b0># ovejas</b0>}}');

      const p = document.createElement('p');
      p.innerHTML = '<b>5</b> sheep';
      root.appendChild(p);
      const b = p.querySelector('b')!;
      const startAnchor = document.createTextNode('');
      const endAnchor = document.createTextNode('');
      p.insertBefore(startAnchor, b);
      p.appendChild(endAnchor);

      translator.processText(p, '<b>5</b> sheep');

      const kids = Array.from(p.childNodes);
      expect(kids).toContain(startAnchor);
      expect(kids).toContain(endAnchor);
      expect(kids.indexOf(startAnchor)).toBeLessThan(kids.indexOf(endAnchor));
      expect(startAnchor.data).toBe('');
      expect(endAnchor.data).toBe('');
      // ...and the rebuilt output is still correct.
      expect(p.innerHTML).toBe('<b>5 ovejas</b>');
    });

    it('preserves an anchor comment through the rebuild fallback (tag set changed)', () => {
      const { translator, store } = createDeps();
      store.set('es', 'See <a0>docs</a0>', 'Ver <a0>docs</a0> <b>ahora</b>');

      const p = document.createElement('p');
      p.innerHTML = 'See <a href="/d">docs</a>';
      const frameworkAnchor = document.createComment('v-if');
      p.appendChild(frameworkAnchor);
      root.appendChild(p);

      translator.processText(p, 'See <a href="/d">docs</a>');

      expect(frameworkAnchor.parentNode).toBe(p); // survived replaceChildren
      expect(p.innerHTML).toBe('Ver <a href="/d">docs</a> <b>ahora</b><!--v-if-->');
    });

    it('keeps only the unreproduced comment when the rebuild recreates the source comment', () => {
      const { translator, store } = createDeps();
      // The rebuild recreates the source's own round-tripped comment, so the live copy is
      // expendable — but the framework's <!--v-if-->, which nothing reproduces, is not.
      store.set('es', 'See <a0>docs</a0> {{0}}', 'Ver <a0>docs</a0> <b>ahora</b> {{0}}');

      const p = document.createElement('p');
      p.innerHTML = 'See <a href="/d">docs</a> <!--src-->';
      const frameworkAnchor = document.createComment('v-if');
      p.insertBefore(frameworkAnchor, p.firstChild);
      root.appendChild(p);

      translator.processText(p, 'See <a href="/d">docs</a> <!--src-->');

      expect(frameworkAnchor.parentNode).toBe(p);
      expect(p.innerHTML).toBe('<!--v-if-->Ver <a href="/d">docs</a> <b>ahora</b> <!--src-->');
      // Exactly one 'src' comment — the rebuilt one; the live copy was not also kept.
      const comments = Array.from(p.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE);
      expect(comments.map((c) => (c as Comment).data)).toEqual(['v-if', 'src']);
    });

    it('does not steal or displace an anchor comment when the source has its own comment', () => {
      const { translator, store } = createDeps();
      // The Masker masks comments as opaque variables, so the source comment round-trips
      // into the translated fragment. The live comment pool must match it by DATA, not by
      // position — otherwise the framework's <!--v-if--> (which sits earlier in document
      // order and is NOT part of the source) gets reused for it and dragged out of place.
      store.set('es', 'Click <a0>here</a0> {{0}}', 'Clic <a0>aqui</a0> {{0}}');

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/x">here</a> <!--src-->';
      const frameworkAnchor = document.createComment('v-if');
      p.insertBefore(frameworkAnchor, p.firstChild);
      root.appendChild(p);
      const srcComment = Array.from(p.childNodes).find(
        (n) => n.nodeType === Node.COMMENT_NODE && (n as Comment).data === 'src'
      ) as Comment;

      translator.processText(p, 'Click <a href="/x">here</a> <!--src-->');

      expect(p.firstChild).toBe(frameworkAnchor); // never moved
      expect(srcComment.parentNode).toBe(p);      // reused in place, not duplicated
      expect(p.querySelector('a')!.textContent).toBe('aqui');
      expect(p.innerHTML).toBe('<!--v-if-->Clic <a href="/x">aqui</a> <!--src-->');
    });

    // `data === ''` alone can't tell a framework anchor from a Text node WE emptied.
    // An ICU arm that renders nothing produces exactly that, and misreading our own node
    // as an anchor means it is never reused and never reclaimed — it is skipped forever
    // while each re-apply appends another node beside it.

    it('reuses the Text node it emptied when the translation renders nothing (ICU zero arm)', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} items', '{0, plural, =0 {} other {# articulos}}');

      const p = document.createElement('p');
      p.textContent = '0 items';
      root.appendChild(p);
      const text = p.firstChild as Text;

      translator.processText(p, '0 items');
      expect(p.childNodes.length).toBe(1);
      expect(p.firstChild).toBe(text); // emptied in place, not replaced
      expect(text.data).toBe('');

      translator.retranslateAll();

      // The emptied node is still ours: reused, not skipped as an anchor and shadowed
      // by a freshly-appended sibling.
      expect(p.childNodes.length).toBe(1);
      expect(p.firstChild).toBe(text);
    });

    it('recovers a Text node it emptied once the translation renders again', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} items', '{0, plural, =0 {} other {# articulos}}');

      const p = document.createElement('p');
      p.textContent = '0 items';
      root.appendChild(p);
      const text = p.firstChild as Text;

      translator.processText(p, '0 items');
      expect(text.data).toBe('');

      // Same element, new source: the node we emptied must take the text back.
      translator.processText(p, '3 items');

      expect(p.childNodes.length).toBe(1);
      expect(p.firstChild).toBe(text);
      expect(text.data).toBe('3 articulos');
    });

    it('recognizes its own output on a node unit whose Text node the framework replaced', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.appendChild(document.createTextNode('Hello'));
      root.appendChild(p);

      translator.processText(p, 'Hello', p.firstChild as Text);
      expect(p.textContent).toBe('Hola');

      // The framework re-creates the node carrying OUR translation as its text. It has no
      // unit record, so only the value-based guard can tell it isn't a fresh source string.
      const replacement = document.createTextNode('Hola');
      p.replaceChild(replacement, p.firstChild!);

      translator.processText(p, 'Hola', replacement);

      expect(enqueueSpy).not.toHaveBeenCalled();          // never reported as new source
      expect(p.getAttribute('data-i18n-original')).toBe('Hello');
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);

      // ...and the re-established unit reverts to the right original.
      translator.revertAll();
      expect(p.textContent).toBe('Hello');
    });

    it('still treats a framework-emptied Text node as an anchor', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Some text', 'Texto');

      const p = document.createElement('p');
      const anchor = document.createTextNode(''); // the framework's, never written by us
      const text = document.createTextNode('Some text');
      p.append(anchor, text);
      root.appendChild(p);

      translator.processText(p, 'Some text');

      expect(Array.from(p.childNodes)).toEqual([anchor, text]);
      expect(anchor.data).toBe('');
      expect(text.data).toBe('Texto');
    });
  });

  // Provenance (`emptiedByUs`) is read by four consumers: setLeafText, the reconcile's text
  // pool, and — via isStructuralChild — arrangeChildren and collectStructuralChildren.
  // Getting it wrong is silently destructive in BOTH directions, so each test below is
  // written to fail if isAnchorText were `data === ''` alone (a node we blanked is mistaken
  // for an anchor: skipped forever, shadowed by a fresh sibling on each re-apply) or if it
  // always returned false (a real anchor is reused/reordered/reclaimed, so the framework's
  // next removeFragment walks nextSibling off the end of the child list).
  describe('empty-Text provenance across the reconcile, rebuild and revert paths', () => {
    const ICU_ZERO = '{0, plural, =0 {} other {# articulos}}';

    /** Empty `p`'s single Text node the way an ICU zero arm does, and hand it back. */
    function emptyTheTextNode(translator: Translator, p: HTMLElement): Text {
      const node = p.firstChild as Text;
      translator.processText(p, '0 items');
      expect(node.data).toBe(''); // engine-emptied, still in place
      return node;
    }

    it('pools and reuses an engine-emptied Text node when reconciling an aggregated unit', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} items', ICU_ZERO);
      store.set('es', '<b0>bold</b0> tail', '<b0>negrita</b0> cola');

      const p = document.createElement('p');
      p.textContent = '0 items';
      root.appendChild(p);
      const emptied = emptyTheTextNode(translator, p);

      // The element becomes an aggregation target: inline markup plus direct text arrives
      // around the node we blanked.
      const b = document.createElement('b');
      b.textContent = 'bold';
      p.append(b, document.createTextNode(' tail'));

      translator.processText(p, '<b>bold</b> tail');

      // The blanked node is ours, so it is drawn from the text pool and refilled in place —
      // not skipped as structural and shadowed by a newly created sibling.
      expect(Array.from(p.childNodes)).toEqual([b, emptied]);
      expect(emptied.data).toBe(' cola');
      expect(b.textContent).toBe('negrita');
    });

    it('never pools a framework anchor for content, and never reclaims it as a leftover', () => {
      const { translator, store } = createDeps();
      store.set('es', '<b0>bold</b0> tail', '<b0>negrita</b0> cola');

      const p = document.createElement('p');
      p.innerHTML = '<b>bold</b> tail';
      const b = p.querySelector('b')!;
      const tail = p.lastChild as Text;
      const anchor = document.createTextNode(''); // the framework's
      p.insertBefore(anchor, b);
      root.appendChild(p);

      translator.processText(p, '<b>bold</b> tail');

      // Anchor keeps identity AND position; the real text node took the translation.
      expect(Array.from(p.childNodes)).toEqual([anchor, b, tail]);
      expect(anchor.data).toBe('');
      expect(tail.data).toBe(' cola');
    });

    it('rebuilds over an engine-emptied node but carries a framework anchor across', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} items', ICU_ZERO);
      // ICU can't map markers 1:1, so this forces the replaceChildren rebuild fallback.
      store.set('es', '<b0>{{0}}</b0> sheep', '{0, plural, one {<b0># oveja</b0>} other {<b0># ovejas</b0>}}');

      const p = document.createElement('p');
      p.textContent = '0 items';
      root.appendChild(p);
      const emptied = emptyTheTextNode(translator, p);

      const anchor = document.createTextNode(''); // the framework's
      p.insertBefore(anchor, emptied);
      const b = document.createElement('b');
      b.textContent = '5';
      p.append(b, document.createTextNode(' sheep'));

      translator.processText(p, '<b>5</b> sheep');

      // Ours is replaceable content and goes; the anchor survives replaceChildren in place.
      expect(emptied.parentNode).toBe(null);
      expect(p.firstChild).toBe(anchor);
      expect(anchor.data).toBe('');
      expect(p.innerHTML).toBe('<b>5 ovejas</b>');
    });

    it('does not mistake a Text node it created empty for a framework anchor', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} items', ICU_ZERO);

      // No text to reuse, so setLeafText mints one via createText — with empty data.
      const p = document.createElement('p');
      const comment = document.createComment('v-if');
      p.appendChild(comment);
      root.appendChild(p);

      translator.processText(p, '0 items');

      expect(p.childNodes.length).toBe(2);
      const minted = p.lastChild as Text;
      expect(minted.nodeType).toBe(Node.TEXT_NODE);
      expect(minted.data).toBe('');

      // Re-apply with a rendering translation: the minted node is ours, so it takes the
      // text rather than being skipped and shadowed.
      translator.processText(p, '3 items');

      expect(Array.from(p.childNodes)).toEqual([comment, minted]);
      expect(minted.data).toBe('3 articulos');
    });

    it('tracks provenance across blank -> fill -> blank, leaving a real anchor untouched', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} items', ICU_ZERO);

      const p = document.createElement('p');
      const anchor = document.createTextNode(''); // the framework's, never written by us
      const text = document.createTextNode('0 items');
      p.append(anchor, text);
      root.appendChild(p);

      translator.processText(p, '0 items'); // blank
      expect(text.data).toBe('');
      expect(Array.from(p.childNodes)).toEqual([anchor, text]);

      translator.processText(p, '3 items'); // fill — the blanked node must be reused
      expect(text.data).toBe('3 articulos');
      expect(Array.from(p.childNodes)).toEqual([anchor, text]);

      translator.processText(p, '0 items'); // blank again
      expect(text.data).toBe('');
      expect(Array.from(p.childNodes)).toEqual([anchor, text]);
      expect(anchor.data).toBe(''); // never written, never moved, never reclaimed
    });

    it('reverts the original into the node it emptied, leaving a real anchor alone', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} items', ICU_ZERO);

      const p = document.createElement('p');
      const anchor = document.createTextNode(''); // the framework's
      const text = document.createTextNode('0 items');
      p.append(anchor, text);
      root.appendChild(p);

      translator.processText(p, '0 items');
      expect(text.data).toBe('');

      translator.revertAll();

      expect(Array.from(p.childNodes)).toEqual([anchor, text]);
      expect(text.data).toBe('0 items'); // restored into the node we blanked
      expect(anchor.data).toBe('');
      expect(p.hasAttribute('data-i18n-original')).toBe(false);
    });
  });

  describe('skipping untranslatable content', () => {
    it('should skip text that masks to only variables', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'Mary';
      root.appendChild(p);

      translator.processText(p, 'Mary');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
      expect(p.textContent).toBe('Mary');
    });

    it('should skip text that masks to only a number', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = '42';
      root.appendChild(p);

      translator.processText(p, '42');

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should skip text that masks to multiple variables with whitespace', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'John Mary';
      root.appendChild(p);

      translator.processText(p, 'John Mary');

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should skip text that masks to variable with trailing space', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'John ';
      root.appendChild(p);

      translator.processText(p, 'John ');

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should still process text that has letters after masking', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'Hello Mary';
      root.appendChild(p);

      translator.processText(p, 'Hello Mary');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('Hello {{0}}');
    });

    it('should skip attribute that masks to only variables', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const input = document.createElement('input');
      input.setAttribute('placeholder', '123');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', '123');

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should still translate when keyOverride is set even if no translatable content', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.setAttribute('data-i18n-key', 'player.name');
      p.textContent = 'John';
      root.appendChild(p);

      translator.processText(p, 'John');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('player.name');
    });

    it('should skip symbols-only text', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = '© 2024';
      root.appendChild(p);

      translator.processText(p, '© 2024');

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should skip number with leading punctuation', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = '+0.00';
      root.appendChild(p);

      translator.processText(p, '+0.00');

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should skip date-only text', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = '01/15/2024';
      root.appendChild(p);

      translator.processText(p, '01/15/2024');

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should skip text with non-allowed HTML tags containing only numbers', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const div = document.createElement('div');
      // Simulates phone number inside complex HTML (SVG icons, divs, etc.)
      const html = '<span class="flex"><div class="bg-white"><svg role="img" width="48"></svg></div><a href="tel:+18881234567">+1 888-123-4567</a></span>';
      div.innerHTML = html;
      root.appendChild(div);

      translator.processText(div, html);

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should still translate text with non-allowed HTML tags when translatable words exist', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const div = document.createElement('div');
      const html = '<div class="icon"><svg width="16"></svg></div> Contact us';
      div.innerHTML = html;
      root.appendChild(div);

      translator.processText(div, html);

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('case normalization', () => {
    it('should use the same cache key for lowercase and uppercase text', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p1 = document.createElement('p');
      p1.textContent = 'hello';
      root.appendChild(p1);
      translator.processText(p1, 'hello');

      const p2 = document.createElement('p');
      p2.textContent = 'HELLO';
      root.appendChild(p2);
      translator.processText(p2, 'HELLO');

      // Both should use the same key "hello", so only one enqueue
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('hello');
    });

    it('should uppercase the translated result for all-uppercase original', () => {
      const { translator, store } = createDeps();
      store.set('es', 'hello', 'hola');

      const p = document.createElement('p');
      p.textContent = 'HELLO';
      root.appendChild(p);

      translator.processText(p, 'HELLO');

      expect(p.textContent).toBe('HOLA');
    });

    it('should not uppercase the result for lowercase original', () => {
      const { translator, store } = createDeps();
      store.set('es', 'hello', 'hola');

      const p = document.createElement('p');
      p.textContent = 'hello';
      root.appendChild(p);

      translator.processText(p, 'hello');

      expect(p.textContent).toBe('hola');
    });

    it('should use separate key for mixed-case text', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p1 = document.createElement('p');
      p1.textContent = 'hello';
      root.appendChild(p1);
      translator.processText(p1, 'hello');

      const p2 = document.createElement('p');
      p2.textContent = 'Hello';
      root.appendChild(p2);
      translator.processText(p2, 'Hello');

      // Mixed case "Hello" should be a separate key from lowercase "hello"
      expect(enqueueSpy).toHaveBeenCalledTimes(2);
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('hello');
      expect(enqueueSpy.mock.calls[1]![0].masked).toBe('Hello');
    });

    it('should uppercase result via applyPending for uppercase original', () => {
      const { translator, store } = createDeps();

      const p = document.createElement('p');
      p.textContent = 'HELLO';
      root.appendChild(p);

      translator.processText(p, 'HELLO');
      expect(p.hasAttribute('data-i18n-pending')).toBe(true);

      store.set('es', 'hello', 'hola');
      translator.applyPending('hello');

      expect(p.textContent).toBe('HOLA');
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
    });

    it('should uppercase attribute translation for uppercase original', () => {
      const { translator, store } = createDeps();
      store.set('es', 'enter name', 'ingrese nombre');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'ENTER NAME');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', 'ENTER NAME');

      expect(input.getAttribute('placeholder')).toBe('INGRESE NOMBRE');
    });

    it('should uppercase HTML translation but preserve tag internals', () => {
      const { translator, store } = createDeps();
      store.set('es', 'click <a0>here</a0> to login', 'haga clic <a0>aqui</a0> para iniciar');

      const p = document.createElement('p');
      p.innerHTML = 'CLICK <a href="/login">HERE</a> TO LOGIN';
      root.appendChild(p);

      translator.processText(p, 'CLICK <a href="/login">HERE</a> TO LOGIN');

      expect(p.innerHTML).toBe('HAGA CLIC <a href="/login">AQUI</a> PARA INICIAR');
    });
  });

  describe('whitespace restoration', () => {
    it('should trim leading space from cache key but restore in translation', () => {
      const { translator, store } = createDeps();
      // Key is trimmed: "{{0}} of {{1}}"
      store.set('es', '{{0}} of {{1}}', '{{0}} de {{1}}');

      const span = document.createElement('span');
      span.textContent = ' 1 of 3';
      root.appendChild(span);

      translator.processText(span, ' 1 of 3');

      expect(span.textContent).toBe(' 1 de 3');
    });

    it('should share key between text with and without leading space', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p1 = document.createElement('p');
      p1.textContent = 'hello';
      root.appendChild(p1);
      translator.processText(p1, 'hello');

      const p2 = document.createElement('p');
      p2.textContent = ' hello';
      root.appendChild(p2);
      translator.processText(p2, ' hello');

      // Both should use the same trimmed key "hello"
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('hello');
    });

    it('should restore trailing whitespace after translation', () => {
      const { translator, store } = createDeps();
      store.set('es', 'hello', 'hola');

      const p = document.createElement('p');
      p.textContent = 'hello  ';
      root.appendChild(p);

      translator.processText(p, 'hello  ');

      expect(p.textContent).toBe('hola  ');
    });

    it('should restore whitespace via applyPending', () => {
      const { translator, store } = createDeps();

      const span = document.createElement('span');
      span.textContent = ' hello ';
      root.appendChild(span);

      translator.processText(span, ' hello ');
      expect(span.hasAttribute('data-i18n-pending')).toBe(true);

      store.set('es', 'hello', 'hola');
      translator.applyPending('hello');

      expect(span.textContent).toBe(' hola ');
    });

    it('should restore whitespace for attribute translations', () => {
      const { translator, store } = createDeps();
      store.set('es', 'enter name', 'ingrese nombre');

      const input = document.createElement('input');
      input.setAttribute('placeholder', ' enter name ');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', ' enter name ');

      expect(input.getAttribute('placeholder')).toBe(' ingrese nombre ');
    });

    it('should combine whitespace restoration with case normalization', () => {
      const { translator, store } = createDeps();
      store.set('es', 'hello', 'hola');

      const p = document.createElement('p');
      p.textContent = ' HELLO ';
      root.appendChild(p);

      translator.processText(p, ' HELLO ');

      expect(p.textContent).toBe(' HOLA ');
    });
  });

  describe('scope support', () => {
    it('should resolve scoped translation from cache (string entry works for any scope)', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Submit', 'Enviar');

      const section = document.createElement('section');
      section.setAttribute('data-i18n-scope', 'checkout');
      const p = document.createElement('p');
      p.textContent = 'Submit';
      section.appendChild(p);
      root.appendChild(section);

      translator.processText(p, 'Submit');

      expect(p.textContent).toBe('Enviar');
    });

    it('should resolve scoped translation from Record entry', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Submit', { checkout: 'Finalizar compra', settings: 'Guardar' });

      const section = document.createElement('section');
      section.setAttribute('data-i18n-scope', 'checkout');
      const p = document.createElement('p');
      p.textContent = 'Submit';
      section.appendChild(p);
      root.appendChild(section);

      translator.processText(p, 'Submit');

      expect(p.textContent).toBe('Finalizar compra');
    });

    it('should not translate when Record entry lacks matching scope', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Submit', { checkout: 'Finalizar compra' });

      const p = document.createElement('p');
      p.textContent = 'Submit';
      root.appendChild(p);

      translator.processText(p, 'Submit');

      // No scope on element, Record has no match → not translated
      expect(p.textContent).toBe('Submit');
    });

    it('should inherit scope from ancestor element', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Submit', { checkout: 'Finalizar compra' });

      const page = document.createElement('div');
      page.setAttribute('data-i18n-scope', 'checkout');
      const section = document.createElement('section');
      const p = document.createElement('p');
      p.textContent = 'Submit';
      section.appendChild(p);
      page.appendChild(section);
      root.appendChild(page);

      translator.processText(p, 'Submit');

      expect(p.textContent).toBe('Finalizar compra');
    });

    it('should include scope in enqueued TranslationItem', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const section = document.createElement('section');
      section.setAttribute('data-i18n-scope', 'checkout');
      const p = document.createElement('p');
      p.textContent = 'Submit';
      section.appendChild(p);
      root.appendChild(section);

      translator.processText(p, 'Submit');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].scope).toBe('checkout');
    });

    it('should not include scope when element has no scope ancestor', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].scope).toBeUndefined();
    });

    it('should resolve scope per-node in applyPending', () => {
      const { translator, store } = createDeps();

      const section1 = document.createElement('section');
      section1.setAttribute('data-i18n-scope', 'checkout');
      const p1 = document.createElement('p');
      p1.textContent = 'Submit';
      section1.appendChild(p1);
      root.appendChild(section1);

      const section2 = document.createElement('section');
      section2.setAttribute('data-i18n-scope', 'settings');
      const p2 = document.createElement('p');
      p2.textContent = 'Submit';
      section2.appendChild(p2);
      root.appendChild(section2);

      translator.processText(p1, 'Submit');
      translator.processText(p2, 'Submit');

      store.set('es', 'Submit', { checkout: 'Finalizar compra', settings: 'Guardar' });
      translator.applyPending('Submit');

      expect(p1.textContent).toBe('Finalizar compra');
      expect(p2.textContent).toBe('Guardar');
    });

    it('should resolve scope for attribute translations', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Enter name', { form: 'Ingrese nombre', search: 'Buscar nombre' });

      const section = document.createElement('section');
      section.setAttribute('data-i18n-scope', 'form');
      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      section.appendChild(input);
      root.appendChild(section);

      translator.processAttribute(input, 'placeholder', 'Enter name');

      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');
    });

    it('should resolve scope in retranslateAll', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Submit', 'Enviar');

      const section = document.createElement('section');
      section.setAttribute('data-i18n-scope', 'checkout');
      const p = document.createElement('p');
      p.textContent = 'Submit';
      section.appendChild(p);
      root.appendChild(section);

      translator.processText(p, 'Submit');
      expect(p.textContent).toBe('Enviar');

      // Now change to scoped entry
      store.set('es', 'Submit', { checkout: 'Finalizar compra' });
      translator.retranslateAll();

      expect(p.textContent).toBe('Finalizar compra');
    });
  });

  describe('error handling', () => {
    it('should handle node removed from DOM before translation arrives', () => {
      const { translator, store } = createDeps();

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      // Remove node from DOM
      root.removeChild(p);

      // Simulate translation arriving - should not throw
      store.set('es', 'Hello', 'Hola');
      expect(() => translator.applyPending('Hello')).not.toThrow();
    });
  });

  describe('ICU MessageFormat', () => {
    it('should evaluate ICU plural from cached translation (sync)', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} sheep', '{0, plural, one {# oveja} other {# ovejas}}');

      const p = document.createElement('p');
      p.textContent = '5 sheep';
      root.appendChild(p);

      translator.processText(p, '5 sheep');

      expect(p.textContent).toBe('5 ovejas');
    });

    it('should evaluate ICU plural via applyPending (async)', () => {
      const { translator, store } = createDeps();

      const p = document.createElement('p');
      p.textContent = '1 sheep';
      root.appendChild(p);

      translator.processText(p, '1 sheep');
      expect(p.hasAttribute('data-i18n-pending')).toBe(true);

      store.set('es', '{{0}} sheep', '{0, plural, one {# oveja} other {# ovejas}}');
      translator.applyPending('{{0}} sheep');

      expect(p.textContent).toBe('1 oveja');
    });

    it('should pass VariableInfo objects (not strings) in enqueued items', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'Hello Mary';
      root.appendChild(p);

      translator.processText(p, 'Hello Mary');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const item = enqueueSpy.mock.calls[0]![0];
      expect(item.variables).toEqual([
        { value: 'Mary', type: 'ignoreWord' },
      ]);
    });
  });

  describe('debug mode', () => {
    it('should include debug info on enqueued items when debug=true', () => {
      const { translator, queue } = createDeps({ configOverrides: { debug: true } });
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const item = enqueueSpy.mock.calls[0]![0];
      expect(item.debug).toBeDefined();
      expect(item.debug!.elementOpenTag).toBe('<p>');
      expect(item.debug!.source).toBe('text');
      expect(item.debug!.childElements).toEqual([]);
    });

    it('should not include debug info when debug=false', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].debug).toBeUndefined();
    });

    it('should capture child elements in debug info', () => {
      const { translator, queue } = createDeps({ configOverrides: { debug: true } });
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const btn = document.createElement('button');
      const div = document.createElement('div');
      div.className = 'spinner';
      const span = document.createElement('span');
      span.className = 'label';
      span.textContent = 'Next';
      btn.appendChild(div);
      btn.appendChild(span);
      root.appendChild(btn);

      translator.processText(btn, btn.innerHTML);

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const debug = enqueueSpy.mock.calls[0]![0].debug!;
      expect(debug.childElements).toEqual([
        { tag: 'DIV', classes: 'spinner' },
        { tag: 'SPAN', classes: 'label' },
      ]);
    });

    it('should set source to attribute name for processAttribute', () => {
      const { translator, queue } = createDeps({ configOverrides: { debug: true } });
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', 'Enter name');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const debug = enqueueSpy.mock.calls[0]![0].debug!;
      expect(debug.source).toBe('attribute:placeholder');
      expect(debug.elementOpenTag).toContain('<input');
    });

    it('should include element attributes in elementOpenTag', () => {
      const { translator, queue } = createDeps({ configOverrides: { debug: true } });
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      const btn = document.createElement('button');
      btn.id = 'submit-btn';
      btn.className = 'btn primary';
      btn.setAttribute('data-v-abc123', '');
      btn.textContent = 'Submit';
      root.appendChild(btn);

      translator.processText(btn, 'Submit');

      const debug = enqueueSpy.mock.calls[0]![0].debug!;
      expect(debug.elementOpenTag).toContain('id="submit-btn"');
      expect(debug.elementOpenTag).toContain('class="btn primary"');
      expect(debug.elementOpenTag).toContain('data-v-abc123');
      expect(debug.elementOpenTag).toMatch(/^<button\s/);
    });
  });

  describe('ICU evaluation failure fallback', () => {
    it('should apply the original text when a cached ICU translation fails to evaluate', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} sheep', '{0, plural, {broken}');

      const p = document.createElement('p');
      p.textContent = '5 sheep';
      root.appendChild(p);

      translator.processText(p, '5 sheep');

      expect(p.textContent).toBe('5 sheep');
      expect(p.getAttribute('data-i18n-original')).toBe('5 sheep');
    });

    it('should preserve edge whitespace when falling back to the original text', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} sheep', '{0, plural, {broken}');

      const p = document.createElement('p');
      p.textContent = '  5 sheep  ';
      root.appendChild(p);

      translator.processText(p, '  5 sheep  ');

      expect(p.textContent).toBe('  5 sheep  ');
    });

    it('should apply the original attribute value when a cached ICU translation fails to evaluate', () => {
      const { translator, store } = createDeps();
      store.set('es', '{{0}} results', '{0, plural, {broken}');

      const input = document.createElement('input');
      input.setAttribute('placeholder', '10 results');
      root.appendChild(input);

      translator.processAttribute(input, 'placeholder', '10 results');

      expect(input.getAttribute('placeholder')).toBe('10 results');
    });
  });

  describe('externally changed content (stale-state guards)', () => {
    it('should ignore the echo of its own applied translation', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);
      translator.processText(p, 'Hello');
      expect(p.textContent).toBe('Hola');

      // The observer echoes our own write back at us
      translator.processText(p, 'Hola');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
      expect(p.textContent).toBe('Hola');
      expect(p.getAttribute('data-i18n-original')).toBe('Hello');
    });

    it('should ignore the innerHTML echo after an inline-tag translation', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Click <a0>here</a0>', 'Clic <a0>aquí</a0>');

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/x">here</a>';
      root.appendChild(p);
      translator.processText(p, 'Click <a href="/x">here</a>');
      expect(p.textContent).toBe('Clic aquí');

      // Mutation-driven re-walk aggregates the translated innerHTML back to us
      translator.processText(p, p.innerHTML);

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
      expect(p.textContent).toBe('Clic aquí');
    });

    it('should not touch translated content it did not write itself (e.g. server-rendered)', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      root.innerHTML = '<p data-i18n-original="Hello">Hola</p>';
      const p = root.querySelector('p')!;

      translator.processText(p, 'Hola');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
      expect(p.textContent).toBe('Hola');
      expect(store.has('es', 'Hola')).toBe(false);
    });

    it('should not touch translated attributes it did not write itself (e.g. server-rendered)', () => {
      const { translator, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');

      root.innerHTML = '<input placeholder="Ingrese nombre" data-i18n-original-placeholder="Enter name" />';
      const input = root.querySelector('input')!;

      translator.processAttribute(input, 'placeholder', 'Ingrese nombre');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');
    });

    it('should re-translate an element whose text was externally replaced after translation', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');
      store.set('es', 'Goodbye', 'Adiós');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);
      translator.processText(p, 'Hello');
      expect(p.textContent).toBe('Hola');

      // Framework patches the element with new source text
      p.textContent = 'Goodbye';
      translator.processText(p, 'Goodbye');

      expect(p.textContent).toBe('Adiós');
      expect(p.getAttribute('data-i18n-original')).toBe('Goodbye');
    });

    it('applyPending should skip a node whose content changed since it was tracked', () => {
      const { translator, store } = createDeps();

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);
      translator.processText(p, 'Hello'); // uncached — tracked as pending

      // Framework patches the element while the translation is in flight
      p.textContent = 'Changed externally';

      store.set('es', 'Hello', 'Hola');
      translator.applyPending('Hello');

      expect(p.textContent).toBe('Changed externally');
    });

    it('applyPending should skip an attribute whose value changed since it was tracked', () => {
      const { translator, store } = createDeps();

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);
      translator.processAttribute(input, 'placeholder', 'Enter name'); // uncached — tracked

      input.setAttribute('placeholder', 'Enter email');

      store.set('es', 'Enter name', 'Ingrese nombre');
      translator.applyPending('Enter name');

      expect(input.getAttribute('placeholder')).toBe('Enter email');
      expect(input.hasAttribute('data-i18n-original-placeholder')).toBe(false);
    });

    it('revertAll should keep text that changed after translation but still remove markers', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);
      translator.processText(p, 'Hello');
      expect(p.textContent).toBe('Hola');

      p.textContent = 'Newer content';
      translator.revertAll();

      expect(p.textContent).toBe('Newer content');
      expect(p.hasAttribute('data-i18n-original')).toBe(false);
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
    });

    it('revertAll preserves child element node identity for an aggregated unit', () => {
      // Symmetric to the apply path: reverting an aggregated sentence that holds a
      // framework-tracked child (a router-link) must reuse the live child node, not
      // blow it away via `innerHTML =`. Orphaning it crashes the framework on the
      // node's next unmount — the same class of bug the apply-side morph fixes.
      const { translator, store } = createDeps();
      store.set('es', 'Completado <a0>Reto</a0>', 'Done <a0>Task</a0>');

      const div = document.createElement('div');
      div.innerHTML = 'Completado <a href="/x">Reto</a>';
      root.appendChild(div);

      translator.processText(div, 'Completado <a href="/x">Reto</a>');
      const anchor = div.querySelector('a')!;
      expect(div.innerHTML).toBe('Done <a href="/x">Task</a>');

      translator.revertAll();

      // Content restored...
      expect(div.innerHTML).toBe('Completado <a href="/x">Reto</a>');
      // ...and the SAME <a> element instance survived the revert.
      expect(div.querySelector('a')).toBe(anchor);
      expect(div.hasAttribute('data-i18n-original')).toBe(false);
    });

    it('revertAll should still restore unchanged translated text', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);
      translator.processText(p, 'Hello');

      translator.revertAll();

      expect(p.textContent).toBe('Hello');
      expect(p.hasAttribute('data-i18n-original')).toBe(false);
    });

    it('retranslateAll should not overwrite text that changed since translation', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');
      store.set('fr', 'Hello', 'Bonjour');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);
      translator.processText(p, 'Hello');
      expect(p.textContent).toBe('Hola');

      p.textContent = 'Patched content';
      translator.setLocale('fr');
      translator.retranslateAll();

      expect(p.textContent).toBe('Patched content');
    });

    it('retranslateAll should not overwrite an attribute that changed since translation', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Enter name', 'Ingrese nombre');
      store.set('fr', 'Enter name', 'Entrez le nom');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);
      translator.processAttribute(input, 'placeholder', 'Enter name');
      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');

      input.setAttribute('placeholder', 'Patched hint');
      translator.setLocale('fr');
      translator.retranslateAll();

      expect(input.getAttribute('placeholder')).toBe('Patched hint');
    });

    it('revertAll should keep an attribute that changed after translation but still remove its marker', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Enter name', 'Ingrese nombre');

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Enter name');
      root.appendChild(input);
      translator.processAttribute(input, 'placeholder', 'Enter name');
      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');

      input.setAttribute('placeholder', 'Enter email');
      translator.revertAll();

      expect(input.getAttribute('placeholder')).toBe('Enter email');
      expect(input.hasAttribute('data-i18n-original-placeholder')).toBe(false);
    });
  });

  // The element-identity echo guard (lastApplied + exact string) misses our own
  // output when a framework re-creates the node (transition, v-if, keyed reorder)
  // or when whitespace drifts. The value-based, locale-scoped guard recognizes
  // the applied output regardless of node identity or exact equality, so we never
  // re-collect a translation as a fresh (target-language) source string.
  describe('value-based echo guard (framework node replacement / whitespace)', () => {
    it('recognizes its own output re-collected on a framework-recreated node and does not report it', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Notification', 'Notificación');

      const p1 = document.createElement('p');
      p1.textContent = 'Notification';
      root.appendChild(p1);
      translator.processText(p1, 'Notification');
      expect(p1.textContent).toBe('Notificación');
      enqueueSpy.mockClear();

      // Framework remounts: the original node is gone, a NEW node carries the
      // OUTPUT text, with no lastApplied entry and no data-i18n-original marker.
      root.removeChild(p1);
      const p2 = document.createElement('p');
      p2.textContent = 'Notificación';
      root.appendChild(p2);

      translator.processText(p2, 'Notificación');

      expect(enqueueSpy).not.toHaveBeenCalled();
      // Marker re-stamped on the new node so it participates going forward.
      expect(p2.getAttribute('data-i18n-original')).toBe('Notification');
      expect(p2.textContent).toBe('Notificación'); // already correct — not re-applied
    });

    it('recognizes its own output despite trailing-whitespace drift on a fresh node', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Notification', 'Notificación');

      const p1 = document.createElement('p');
      p1.textContent = 'Notification';
      root.appendChild(p1);
      translator.processText(p1, 'Notification');
      enqueueSpy.mockClear();

      const p2 = document.createElement('p');
      p2.textContent = 'Notificación '; // trailing space — defeats raw === compare
      root.appendChild(p2);
      translator.processText(p2, 'Notificación ');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(p2.getAttribute('data-i18n-original')).toBe('Notification');
    });

    it('recognizes its own applied attribute output on a framework-recreated node', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Notifications', 'Notificaciones');

      const i1 = document.createElement('input');
      i1.setAttribute('title', 'Notifications');
      root.appendChild(i1);
      translator.processAttribute(i1, 'title', 'Notifications');
      expect(i1.getAttribute('title')).toBe('Notificaciones');
      enqueueSpy.mockClear();

      // The OUTPUT value lands on a new node with no original-tracking marker.
      const i2 = document.createElement('input');
      i2.setAttribute('title', 'Notificaciones');
      root.appendChild(i2);
      translator.processAttribute(i2, 'title', 'Notificaciones');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(i2.getAttribute('data-i18n-original-title')).toBe('Notifications');
      expect(i2.getAttribute('title')).toBe('Notificaciones');
    });

    it('still reports a genuinely new source string that is not any known output', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Notification', 'Notificación');

      const p1 = document.createElement('p');
      p1.textContent = 'Notification';
      root.appendChild(p1);
      translator.processText(p1, 'Notification');
      enqueueSpy.mockClear();

      const p2 = document.createElement('p');
      p2.textContent = 'Settings'; // brand-new source, not an output
      root.appendChild(p2);
      translator.processText(p2, 'Settings');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('Settings');
    });

    it('is locale-scoped: an output indexed under locale A does not suppress reporting under locale B', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Notification', 'Notificación');

      const p1 = document.createElement('p');
      p1.textContent = 'Notification';
      root.appendChild(p1);
      translator.processText(p1, 'Notification'); // indexes es → "Notificación"
      enqueueSpy.mockClear();

      translator.setLocale('de');

      const p2 = document.createElement('p');
      p2.textContent = 'Notificación'; // same value, but the active locale is now de
      root.appendChild(p2);
      translator.processText(p2, 'Notificación');

      expect(enqueueSpy).toHaveBeenCalledTimes(1); // reported: not a `de` output
      expect(enqueueSpy.mock.calls[0]![0].masked).toBe('Notificación');
    });

    it('suppresses a new source that coincidentally equals a known output in the active locale (documented trade-off)', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Hello', 'Hola');

      const p1 = document.createElement('p');
      p1.textContent = 'Hello';
      root.appendChild(p1);
      translator.processText(p1, 'Hello'); // indexes es → "Hola"
      enqueueSpy.mockClear();

      // A genuinely-new source string that happens to equal the "Hola" output.
      // The accepted false positive: it is suppressed rather than reported.
      const p2 = document.createElement('p');
      p2.textContent = 'Hola';
      root.appendChild(p2);
      translator.processText(p2, 'Hola');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(p2.getAttribute('data-i18n-original')).toBe('Hello');
    });

    it('regression: still ignores the same-element exact-match echo without consulting the value index', () => {
      const { translator, store, queue } = createDeps();
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);
      translator.processText(p, 'Hello');
      expect(p.textContent).toBe('Hola');

      // Same element, byte-identical echo — caught by the element-identity guard.
      translator.processText(p, 'Hola');

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(p.getAttribute('data-i18n-original')).toBe('Hello');
    });
  });

  describe('pending node retention', () => {
    // A `reported` key is one the consumer was asked about and declined to translate.
    // No applyPending will ever come for it, so tracking its nodes only pins them —
    // and their whole detached DOM subtree — in memory for the life of the page.
    it('does not retain pending nodes for a reported key across re-renders', () => {
      const { translator, store } = createDeps();

      const first = document.createElement('p');
      first.textContent = 'Hello world';
      root.appendChild(first);
      translator.processText(first, 'Hello world');
      expect(translator.pendingNodeCount).toBe(1); // in flight — legitimately tracked

      store.markReported('es', 'Hello world'); // consumer declined it

      // The same string re-renders over and over (virtualized list, route changes).
      for (let i = 0; i < 50; i++) {
        const el = document.createElement('p');
        el.textContent = 'Hello world';
        root.appendChild(el);
        translator.processText(el, 'Hello world');
        el.remove(); // and is torn down again
      }

      expect(translator.pendingNodeCount).toBe(1);
    });

    it('does not retain pending nodes for a reported attribute key across re-renders', () => {
      const { translator, store } = createDeps();

      const first = document.createElement('input');
      first.setAttribute('placeholder', 'Search here');
      root.appendChild(first);
      translator.processAttribute(first, 'placeholder', 'Search here');
      expect(translator.pendingNodeCount).toBe(1);

      store.markReported('es', 'Search here');

      for (let i = 0; i < 50; i++) {
        const el = document.createElement('input');
        el.setAttribute('placeholder', 'Search here');
        root.appendChild(el);
        translator.processAttribute(el, 'placeholder', 'Search here');
        el.remove();
      }

      expect(translator.pendingNodeCount).toBe(1);
    });

    it('dropPending forgets a key’s tracked nodes', () => {
      const { translator } = createDeps();

      const p = document.createElement('p');
      p.textContent = 'Hello world';
      root.appendChild(p);
      translator.processText(p, 'Hello world');
      expect(translator.pendingNodeCount).toBe(1);

      translator.dropPending('Hello world');
      expect(translator.pendingNodeCount).toBe(0);
    });

    it('still applies a translation to nodes tracked while the flush was in flight', () => {
      const { translator, store } = createDeps();

      const p = document.createElement('p');
      p.textContent = 'Hello world';
      root.appendChild(p);
      translator.processText(p, 'Hello world'); // pending, tracked

      store.set('es', 'Hello world', 'Hola mundo');
      translator.applyPending('Hello world');

      expect(p.textContent).toBe('Hola mundo');
      expect(translator.pendingNodeCount).toBe(0);
    });
  });
});
