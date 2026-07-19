import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Translator, TranslatorConfig } from '../src/Translator';
import { Store } from '../src/Store';
import { Queue } from '../src/Queue';
import { Masker } from '../src/Masker';
import { serializeAggregate } from '../src/ignore';
import type { TranslationItem } from '../src/types';

const IGNORE_PREDICATE = { ignoreAttribute: 'data-i18n-ignore', ignoreSelectors: [] };

function createDeps(overrides: {
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

/** Config wiring an aggregated (isHtml) element with ignore-boundary support. */
const AGGREGATE_CONFIG: Partial<TranslatorConfig> = {
  serializeAggregate: (el) => serializeAggregate(el, IGNORE_PREDICATE),
  ignorePredicate: IGNORE_PREDICATE,
};

describe('Translator — edge paths', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  describe('syncOriginalAttribute()', () => {
    it('writes no original attribute when the element holds no tracked node units', () => {
      // The unit is scoped to a Text node that is NOT a direct child, so
      // nodeUnitsOf() finds nothing to name in the attribute.
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.innerHTML = '<span>Hello</span>';
      root.appendChild(p);
      const deep = p.querySelector('span')!.firstChild as Text;

      translator.processText(p, 'Hello', deep);

      expect(deep.data).toBe('Hola');
      expect(p.hasAttribute('data-i18n-original')).toBe(false);
    });
  });

  describe('scoped entries that resolve to nothing', () => {
    it('processAttribute leaves the attribute alone when no scope matches', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Save', { other: 'Guardar' });

      const el = document.createElement('button');
      el.setAttribute('title', 'Save');
      root.appendChild(el);

      translator.processAttribute(el, 'title', 'Save');

      expect(el.getAttribute('title')).toBe('Save');
      expect(el.hasAttribute('data-i18n-original-title')).toBe(false);
    });

    it('retranslateUnit leaves text alone when no scope matches', () => {
      const { translator, store } = createDeps();
      const p = document.createElement('p');
      p.textContent = 'Hola';
      p.setAttribute('data-i18n-original', 'Hello');
      root.appendChild(p);

      store.set('es', 'Hello', { other: 'Bonjour' });
      translator.retranslateAll();

      expect(p.textContent).toBe('Hola');
    });

    it('retranslateAll leaves an attribute alone when no scope matches', () => {
      const { translator, store } = createDeps();
      const el = document.createElement('button');
      el.setAttribute('title', 'Guardar');
      el.setAttribute('data-i18n-original-title', 'Save');
      root.appendChild(el);

      store.set('es', 'Save', { other: 'Enregistrer' });
      translator.retranslateAll();

      expect(el.getAttribute('title')).toBe('Guardar');
    });
  });

  describe('applyPending()', () => {
    it('is a no-op for a key with no tracked nodes', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');
      expect(() => translator.applyPending('Hello')).not.toThrow();
    });

    it('is a no-op while the entry is still pending (not resolved)', () => {
      const { translator, store, queue } = createDeps();
      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');
      expect(store.get('es', 'Hello')?.status).toBe('pending');

      translator.applyPending('Hello');

      expect(p.textContent).toBe('Hello');
      expect(translator.pendingNodeCount).toBe(1); // nodes kept for the real apply
      queue.clear();
    });

    it('skips a tracked node whose scope the resolved entry does not cover', () => {
      const { translator, store, queue } = createDeps();
      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');
      store.set('es', 'Hello', { other: 'Hola' });
      translator.applyPending('Hello');

      expect(p.textContent).toBe('Hello');
      queue.clear();
    });
  });

  describe('retranslateAll() skips', () => {
    it('skips a unit whose original has no translatable content', () => {
      const { translator, store } = createDeps();
      const p = document.createElement('p');
      p.textContent = '123';
      p.setAttribute('data-i18n-original', '123');
      root.appendChild(p);

      store.set('es', '{{0}}', 'X');
      translator.retranslateAll();

      expect(p.textContent).toBe('123');
    });

    it('skips an element whose original attribute is empty', () => {
      const { translator } = createDeps();
      const p = document.createElement('p');
      p.textContent = 'Hola';
      p.setAttribute('data-i18n-original', '');
      root.appendChild(p);

      translator.retranslateAll();

      expect(p.textContent).toBe('Hola');
    });

    it('skips an attribute whose original marker is empty', () => {
      const { translator } = createDeps();
      const el = document.createElement('button');
      el.setAttribute('title', 'Guardar');
      el.setAttribute('data-i18n-original-title', '');
      root.appendChild(el);

      translator.retranslateAll();

      expect(el.getAttribute('title')).toBe('Guardar');
    });

    it('skips an attribute whose original has no translatable content', () => {
      const { translator, store } = createDeps();
      const el = document.createElement('button');
      el.setAttribute('title', '123');
      el.setAttribute('data-i18n-original-title', '123');
      root.appendChild(el);

      store.set('es', '{{0}}', 'X');
      translator.retranslateAll();

      expect(el.getAttribute('title')).toBe('123');
    });

    it('snapshots an empty string for an attribute marker whose attribute is gone', () => {
      const { translator, queue, onFlushFn } = createDeps();
      const el = document.createElement('button');
      el.setAttribute('data-i18n-original-title', 'Save');
      root.appendChild(el);

      translator.retranslateAll();

      expect(translator.pendingNodeCount).toBe(1);
      queue.clear();
      expect(onFlushFn).not.toHaveBeenCalled();
    });
  });

  describe('revertAll() guards', () => {
    it('leaves a node-scoped unit whose text changed since we wrote it', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.appendChild(document.createTextNode('Hello'));
      root.appendChild(p);
      const textNode = p.firstChild as Text;

      translator.processText(p, 'Hello', textNode);
      expect(textNode.data).toBe('Hola');

      // A framework rewrote the node after our apply — newer content wins.
      textNode.data = 'Newer';
      translator.revertAll();

      expect(textNode.data).toBe('Newer');
    });

    it('skips an element whose original attribute is empty', () => {
      const { translator } = createDeps();
      const p = document.createElement('p');
      p.textContent = 'Hola';
      p.setAttribute('data-i18n-original', '');
      root.appendChild(p);

      translator.revertAll();

      expect(p.textContent).toBe('Hola');
      expect(p.hasAttribute('data-i18n-original')).toBe(false);
    });

    it('skips an attribute whose original marker is empty', () => {
      const { translator } = createDeps();
      const el = document.createElement('button');
      el.setAttribute('title', 'Guardar');
      el.setAttribute('data-i18n-original-title', '');
      root.appendChild(el);

      translator.revertAll();

      expect(el.getAttribute('title')).toBe('Guardar');
      expect(el.hasAttribute('data-i18n-original-title')).toBe(false);
    });
  });

  describe('revertAll() of an aggregated unit holding an ignored subtree', () => {
    it('morphs the original back on and keeps the live ignored node', () => {
      const { translator, store } = createDeps({ configOverrides: AGGREGATE_CONFIG });
      store.set('es', 'Hola {{0}} mundo', 'Hello {{0}} world');

      const div = document.createElement('div');
      div.innerHTML = 'Hola <span data-i18n-ignore>Jdoe#42</span> mundo';
      root.appendChild(div);
      const ignored = div.querySelector('[data-i18n-ignore]')!;

      translator.processText(div, serializeAggregate(div, IGNORE_PREDICATE));
      expect(div.textContent).toBe('Hello Jdoe#42 world');

      translator.revertAll();

      expect(div.textContent).toBe('Hola Jdoe#42 mundo');
      expect(div.querySelector('[data-i18n-ignore]')).toBe(ignored); // same live node
    });
  });

  describe('ignored-slot placeholders with no live counterpart', () => {
    it('rebuilds the ignored subtree from masked markup on the rebuild fallback', () => {
      const { translator, store } = createDeps({ configOverrides: AGGREGATE_CONFIG });
      // Translation adds a <b> the source lacked → tag-set change → rebuild path.
      store.set('es', 'Hola {{0}} <a0>link</a0>', 'Hello {{0}} <a0>link</a0> <b>extra</b>');

      const div = document.createElement('div');
      div.innerHTML = 'Hola <span data-i18n-ignore>secret</span> <a href="/x">link</a>';
      root.appendChild(div);

      // Capture the aggregate, then drop the ignored node so no live one survives.
      const aggregated = serializeAggregate(div, IGNORE_PREDICATE);
      div.querySelector('[data-i18n-ignore]')!.remove();

      translator.processText(div, aggregated);

      const rebuilt = div.querySelector('[data-i18n-ignore]');
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.textContent).toBe('secret');
      expect(div.querySelector('b')!.textContent).toBe('extra');
    });

    // The placeholder tag name is reserved for the library. A source element that
    // happens to use it carries no `data-k`, so it resolves to no ignored slot and
    // is never mistaken for one. Both apply paths preserve such an unclaimed
    // element verbatim: the reconcile leaves it in place (unclaimed elements are
    // structural), and the rebuild carries it through with the rest of the content.
    // Dropping author markup would be silent data loss.
    it('never claims a source element squatting on the reserved tag (reconcile)', () => {
      const { translator, store } = createDeps({ configOverrides: AGGREGATE_CONFIG });
      store.set('es', 'Hola {{0}} {{1}}x{{2}} mundo', 'Hello {{0}} {{1}}x{{2}} world');

      const div = document.createElement('div');
      div.innerHTML = 'Hola <span data-i18n-ignore>secret</span> <i18n-ignored>x</i18n-ignored> mundo';
      root.appendChild(div);
      const ignored = div.querySelector('[data-i18n-ignore]')!;

      translator.processText(div, serializeAggregate(div, IGNORE_PREDICATE));

      expect(div.querySelector('[data-i18n-ignore]')).toBe(ignored); // real slot kept
      // Resolved to no slot, so it keeps its own identity and content.
      expect(div.querySelector('i18n-ignored:not([data-i18n-ignore])')!.textContent).toBe('x');
      expect(div.textContent).toContain('Hello secret');
    });

    it('keeps a source element that squats on the reserved placeholder tag (rebuild)', () => {
      const { translator, store } = createDeps({ configOverrides: AGGREGATE_CONFIG });
      // Extra <b> forces the rebuild fallback, which restores ignored slots first.
      store.set('es', 'Hola {{0}} {{1}}x{{2}} mundo', 'Hello {{0}} {{1}}x{{2}} world <b>extra</b>');

      const div = document.createElement('div');
      div.innerHTML = 'Hola <span data-i18n-ignore>secret</span> <i18n-ignored>x</i18n-ignored> mundo';
      root.appendChild(div);
      const ignored = div.querySelector('[data-i18n-ignore]')!;

      translator.processText(div, serializeAggregate(div, IGNORE_PREDICATE));

      expect(div.querySelector('[data-i18n-ignore]')).toBe(ignored);
      // Resolved to no slot, so it survives the rebuild with its content intact.
      expect(div.querySelector('i18n-ignored:not([data-i18n-ignore])')!.textContent).toBe('x');
      expect(div.querySelector('b')!.textContent).toBe('extra');
    });

    it('keeps a squatting source element that also carries an out-of-range data-k', () => {
      const { translator, store } = createDeps({ configOverrides: AGGREGATE_CONFIG });
      store.set('es', 'Hola {{0}} {{1}}x{{2}} mundo', 'Hello {{0}} {{1}}x{{2}} world <b>extra</b>');

      const div = document.createElement('div');
      // data-k="7" indexes no ignored slot of this unit (there is exactly one).
      div.innerHTML =
        'Hola <span data-i18n-ignore>secret</span> <i18n-ignored data-k="7">x</i18n-ignored> mundo';
      root.appendChild(div);
      const ignored = div.querySelector('[data-i18n-ignore]')!;

      translator.processText(div, serializeAggregate(div, IGNORE_PREDICATE));

      expect(div.querySelector('[data-i18n-ignore]')).toBe(ignored);
      expect(div.querySelector('i18n-ignored[data-k="7"]')!.textContent).toBe('x');
    });
  });

  describe('rebuild fallback anchoring', () => {
    it('pins a structural child past the end of shrunken content', () => {
      // ICU output renders fewer content nodes than the source had, so the
      // fragment anchor's recorded offset lands past the new content array.
      const { translator, store } = createDeps();
      store.set('es', 'Hello {{0}} <b0>a</b0>tail', '{0, plural, other {Hola}}');

      const p = document.createElement('p');
      p.innerHTML = 'Hello 5 <b>a</b>tail';
      root.appendChild(p);
      // Vue-style empty-Text fragment anchor between <b> and the trailing text.
      const anchor = document.createTextNode('');
      p.insertBefore(anchor, p.lastChild);

      translator.processText(p, 'Hello 5 <b>a</b>tail');

      expect(p.textContent).toBe('Hola');
      expect(anchor.isConnected).toBe(true); // anchor survived the rebuild
      expect(anchor.parentNode).toBe(p);
    });
  });

  describe('filterReportable()', () => {
    it('reports an item that has no tracked nodes to re-validate against', () => {
      const { translator } = createDeps();
      const item: TranslationItem = { masked: 'Hello', original: 'Hello', variables: [] };

      expect(translator.filterReportable([item], () => true)).toEqual([item]);
    });
  });

  describe('unprotectElement()', () => {
    it('keeps a class attribute that carries other classes after removing ours', () => {
      const { translator, store } = createDeps({
        configOverrides: { protectTranslations: true },
      });
      store.set('es', 'Hello', 'Hola');

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');
      expect(p.classList.contains('notranslate')).toBe(true);

      // Someone else added a class after we marked the element.
      p.classList.add('theirs');
      translator.revertAll();

      expect(p.classList.contains('notranslate')).toBe(false);
      expect(p.getAttribute('class')).toBe('theirs');
    });
  });
});
