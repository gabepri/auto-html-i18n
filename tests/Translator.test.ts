import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Translator, TranslatorConfig } from '../src/Translator';
import { Store } from '../src/Store';
import { Queue } from '../src/Queue';
import { Masker } from '../src/Masker';
import { Resolver } from '../src/Resolver';
import type { TranslationItem } from '../src/types';

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
  const resolver = new Resolver({
    context: { gender: 'female' },
    fallbackContext: { gender: 'neutral' },
    contextOrder: ['gender'],
  });
  const onMissingTranslation = vi.fn().mockResolvedValue(null);
  const config: TranslatorConfig = {
    locale: 'es',
    originalAttribute: 'data-i18n-original',
    pendingAttribute: 'data-i18n-pending',
    keyAttribute: 'data-i18n-key',
    onMissingTranslation,
    debug: false,
    ...overrides.configOverrides,
  };

  const translator = new Translator(store, queue, masker, resolver, config);
  return { translator, store, queue, masker, resolver, config, onMissingTranslation, onFlushFn };
}

describe('Translator', () => {
  let root: HTMLElement;

  beforeEach(() => {
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

    it('should resolve variant and apply', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Welcome', { male: 'Bienvenido', female: 'Bienvenida' });

      const p = document.createElement('p');
      p.textContent = 'Welcome';
      root.appendChild(p);

      translator.processText(p, 'Welcome');

      expect(p.textContent).toBe('Bienvenida'); // female context
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

  describe('retranslateAll()', () => {
    it('should re-resolve all elements with originalAttribute', () => {
      const { translator, store } = createDeps();
      store.set('es', 'Hello', { male: 'Hola-M', female: 'Hola-F' });

      const p = document.createElement('p');
      p.textContent = 'Hello';
      root.appendChild(p);

      translator.processText(p, 'Hello');
      expect(p.textContent).toBe('Hola-F'); // female context

      // Now the public API would call resolver.updateContext + retranslateAll
      // For this test, we just verify retranslateAll re-processes nodes
      translator.retranslateAll();

      // Still female context, so still Hola-F
      expect(p.textContent).toBe('Hola-F');
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
      const { translator, store, queue } = createDeps();
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
});
