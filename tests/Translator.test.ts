import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Translator, TranslatorConfig } from '../src/Translator';
import { Store } from '../src/Store';
import { Queue } from '../src/Queue';
import { Masker } from '../src/Masker';
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
  const onMissingTranslation = vi.fn().mockResolvedValue(null);
  const config: TranslatorConfig = {
    locale: 'es',
    originalAttribute: 'data-i18n-original',
    pendingAttribute: 'data-i18n-pending',
    keyAttribute: 'data-i18n-key',
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
});
