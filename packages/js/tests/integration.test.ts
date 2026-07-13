import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { I18nObserver } from '../src/I18nObserver';
import type { TranslationItem } from '../src/types';

async function waitForMutations(): Promise<void> {
  // Flush microtasks and any pending timers to ensure MutationObserver callbacks fire
  await new Promise<void>((resolve) => {
    queueMicrotask(() => {
      queueMicrotask(resolve);
    });
  });
  await vi.advanceTimersByTimeAsync(0);
}

async function flushDebounce(): Promise<void> {
  vi.advanceTimersByTime(250);
  await vi.runAllTimersAsync();
}

describe('Integration Tests', () => {
  let root: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(root);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('full translation flow', () => {
    it('should translate text end-to-end via initial scan', async () => {
      const onMissing = vi.fn<(items: TranslationItem[], locale: string) => Promise<Record<string, string> | null>>()
        .mockResolvedValue({ 'Hello': 'Hola' });

      root.innerHTML = '<p>Hello</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      i18n.start();

      const p = root.querySelector('p')!;

      // Element should be pending after initial scan
      expect(p.hasAttribute('data-i18n-pending')).toBe(true);

      // Flush the debounce to trigger onMissingTranslation
      await flushDebounce();

      expect(onMissing).toHaveBeenCalledTimes(1);
      expect(onMissing.mock.calls[0]![0][0]!.masked).toBe('Hello');
      expect(onMissing.mock.calls[0]![1]).toBe('es');

      // Translation should be applied
      expect(p.textContent).toBe('Hola');
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
      expect(p.getAttribute('data-i18n-original')).toBe('Hello');

      i18n.stop();
    });

    it('should handle inline tags with attribute preservation', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Click <a0>here</a0> to login': 'Haga clic <a0>aqui</a0> para iniciar',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<p>Click <a href="/login" class="btn">here</a> to login</p>';
      i18n.start();

      await flushDebounce();

      const p = root.querySelector('p')!;
      expect(p.innerHTML).toContain('aqui');
      expect(p.innerHTML).toContain('href="/login"');
      expect(p.innerHTML).toContain('class="btn"');

      i18n.stop();
    });

    it('should handle locale switching', async () => {
      const onMissing = vi.fn().mockResolvedValue({ 'Hello': 'Bonjour' });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      });

      root.innerHTML = '<p>Hello</p>';
      i18n.start();

      expect(root.querySelector('p')!.textContent).toBe('Hola');

      // Switch to French (not cached)
      i18n.setLocale('fr');

      await flushDebounce();

      expect(onMissing).toHaveBeenCalled();
      expect(root.querySelector('p')!.textContent).toBe('Bonjour');

      i18n.stop();
    });

    it('should use cached translations instantly (sync path)', () => {
      const onMissing = vi.fn().mockResolvedValue(null);

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        initialCache: { 'Hello': 'Hola', 'World': 'Mundo' },
        rootElement: root,
      });

      root.innerHTML = '<p>Hello</p><p>World</p>';
      i18n.start();

      // Should be applied synchronously, no debounce needed
      const ps = root.querySelectorAll('p');
      expect(ps[0]!.textContent).toBe('Hola');
      expect(ps[1]!.textContent).toBe('Mundo');

      // onMissingTranslation should NOT have been called
      expect(onMissing).not.toHaveBeenCalled();

      i18n.stop();
    });

    it('should handle ignoreWords correctly', async () => {
      const onMissing = vi.fn<(items: TranslationItem[], locale: string) => Promise<Record<string, string>>>()
        .mockResolvedValue({
          '{{0}} has {{1}} cats': '{{0}} tiene {{1}} gatos',
        });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        ignoreWords: ['John'],
        rootElement: root,
      });

      root.innerHTML = '<p>John has 3 cats</p>';
      i18n.start();

      await flushDebounce();

      const item = onMissing.mock.calls[0]![0][0]!;
      expect(item.masked).toBe('{{0}} has {{1}} cats');
      expect(item.variables).toEqual([
        { value: 'John', type: 'ignoreWord' },
        { value: '3', type: 'number' },
      ]);

      expect(root.querySelector('p')!.textContent).toBe('John tiene 3 gatos');

      i18n.stop();
    });

    it('should respect ignoreSelectors', () => {
      const onMissing = vi.fn().mockResolvedValue(null);

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<code>const x = 1;</code><p>Hello</p>';
      i18n.start();

      // Only "Hello" should be queued, not the code content
      const ps = root.querySelectorAll('p');
      expect(ps[0]!.hasAttribute('data-i18n-pending')).toBe(true);

      const code = root.querySelector('code')!;
      expect(code.hasAttribute('data-i18n-pending')).toBe(false);

      i18n.stop();
    });

    it('should translate attributes', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Enter name': 'Ingrese nombre',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<input placeholder="Enter name" />';
      i18n.start();

      await flushDebounce();

      expect(root.querySelector('input')!.getAttribute('placeholder')).toBe('Ingrese nombre');

      i18n.stop();
    });

    it('should handle data-i18n-key override', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'custom.key': 'Texto personalizado',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<span data-i18n-key="custom.key">Some text</span>';
      i18n.start();

      await flushDebounce();

      expect(root.querySelector('span')!.textContent).toBe('Texto personalizado');

      i18n.stop();
    });

    it('should persist and restore cache', () => {
      // First instance: populate cache
      const i18n1 = new I18nObserver({
        locale: 'es',
        onMissingTranslation: vi.fn().mockResolvedValue(null),
        initialCache: { 'Hello': 'Hola', 'Bye': 'Adiós' },
        rootElement: root,
      });

      const cache = i18n1.getCache();
      expect(cache).toEqual({ 'Hello': 'Hola', 'Bye': 'Adiós' });

      // Second instance: restore from cache
      root.innerHTML = '<p>Hello</p>';
      const i18n2 = new I18nObserver({
        locale: 'es',
        onMissingTranslation: vi.fn().mockResolvedValue(null),
        initialCache: cache,
        rootElement: root,
      });

      i18n2.start();
      expect(root.querySelector('p')!.textContent).toBe('Hola');

      i18n2.stop();
    });
  });

  // A parent that can't aggregate (a non-inline child anywhere below disqualifies it)
  // still holds one translation unit per direct text node. Each unit must land on its own
  // Text node: keying them all on the parent element makes the last translation overwrite
  // the first node and reclaim the rest, destroying visible content.
  describe('multiple text nodes under one non-aggregatable parent', () => {
    it('translates each text node around a <br> independently', () => {
      root.innerHTML = '<p>Hello there<br>Goodbye now</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: async () => null,
        rootElement: root,
      });
      i18n.setCache('es', { 'Hello there': 'Hola alli', 'Goodbye now': 'Adios ahora' });
      i18n.start();

      const p = root.querySelector('p')!;
      expect(Array.from(p.childNodes).map((n) => n.nodeName + ':' + n.textContent))
        .toEqual(['#text:Hola alli', 'BR:', '#text:Adios ahora']);
      i18n.stop();
    });

    it('translates text nodes on either side of a form control', () => {
      root.innerHTML = '<label>Hello there<input>Goodbye now</label>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: async () => null,
        rootElement: root,
      });
      i18n.setCache('es', { 'Hello there': 'Hola alli', 'Goodbye now': 'Adios ahora' });
      i18n.start();

      expect(root.querySelector('label')!.textContent).toBe('Hola alliAdios ahora');
      expect(root.querySelector('input')).not.toBe(null);
      i18n.stop();
    });

    it('reverts every text node, not just the first', () => {
      root.innerHTML = '<p>Hello there<br>Goodbye now</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: async () => null,
        rootElement: root,
      });
      i18n.setCache('es', { 'Hello there': 'Hola alli', 'Goodbye now': 'Adios ahora' });
      i18n.start();
      expect(root.querySelector('p')!.textContent).toBe('Hola alliAdios ahora');

      i18n.stop(true); // revert

      expect(root.innerHTML).toBe('<p>Hello there<br>Goodbye now</p>');
    });

    it('re-translates every text node on a locale switch', () => {
      root.innerHTML = '<p>Hello there<br>Goodbye now</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: async () => null,
        rootElement: root,
      });
      i18n.setCache('es', { 'Hello there': 'Hola alli', 'Goodbye now': 'Adios ahora' });
      i18n.setCache('fr', { 'Hello there': 'Bonjour la', 'Goodbye now': 'Au revoir' });
      i18n.start();
      expect(root.querySelector('p')!.textContent).toBe('Hola alliAdios ahora');

      i18n.setLocale('fr');

      expect(root.querySelector('p')!.textContent).toBe('Bonjour laAu revoir');
      i18n.stop();
    });
  });

  describe('attribute re-translation prevention', () => {
    it('should translate attribute exactly once (no re-translation loop)', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Enter name': 'Ingrese nombre',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<input placeholder="Enter name" />';
      i18n.start();

      await flushDebounce();

      // Wait for any cascading mutations to settle
      await waitForMutations();
      await flushDebounce();

      expect(onMissing).toHaveBeenCalledTimes(1);
      const input = root.querySelector('input')!;
      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');
      expect(input.getAttribute('data-i18n-original-placeholder')).toBe('Enter name');

      i18n.stop();
    });

    it('should re-translate attributes on setLocale', async () => {
      const onMissing = vi.fn().mockResolvedValue({ 'Enter name': 'Entrez le nom' });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        initialCache: { 'Enter name': 'Ingrese nombre' },
        rootElement: root,
      });

      root.innerHTML = '<input placeholder="Enter name" />';
      i18n.start();

      const input = root.querySelector('input')!;
      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');
      expect(input.getAttribute('data-i18n-original-placeholder')).toBe('Enter name');

      // Switch to French
      i18n.setLocale('fr');

      await flushDebounce();

      expect(input.getAttribute('placeholder')).toBe('Entrez le nom');
      // Original should still be the English source text
      expect(input.getAttribute('data-i18n-original-placeholder')).toBe('Enter name');

      i18n.stop();
    });

    it('should translate dynamically added element attributes once', async () => {
      vi.useRealTimers();

      const onMissing = vi.fn().mockResolvedValue({
        'Search': 'Buscar',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        debounceTime: 50,
      });

      i18n.start();

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Search');
      root.appendChild(input);

      // Wait for mutation + debounce + any cascading mutations
      await new Promise((r) => setTimeout(r, 200));

      expect(onMissing).toHaveBeenCalledTimes(1);
      expect(input.getAttribute('placeholder')).toBe('Buscar');
      expect(input.getAttribute('data-i18n-original-placeholder')).toBe('Search');

      i18n.stop();
      vi.useFakeTimers();
    });
  });

  describe('error handling', () => {
    it('should handle onMissingTranslation returning null', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<p>Hello</p>';
      i18n.start();

      await flushDebounce();

      // Node stays pending, no crash
      expect(root.querySelector('p')!.textContent).toBe('Hello');

      i18n.stop();
    });

    it('should handle onMissingTranslation throwing', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onMissing = vi.fn().mockRejectedValue(new Error('Network error'));

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<p>Hello</p>';
      i18n.start();

      await flushDebounce();

      // Should not crash, text remains
      expect(root.querySelector('p')!.textContent).toBe('Hello');
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
      i18n.stop();
    });
  });

  describe('security', () => {
    it('should strip onclick from restored tags', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Click <a0>here</a0>': 'Clic <a0>aqui</a0>',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<p>Click <a href="/ok" onclick="alert(1)">here</a></p>';
      i18n.start();

      await flushDebounce();

      const p = root.querySelector('p')!;
      expect(p.innerHTML).toContain('href="/ok"');
      expect(p.innerHTML).not.toContain('onclick');

      i18n.stop();
    });
  });

  describe('re-render scenarios', () => {
    it('should re-translate when text is reset (simulating framework re-render)', async () => {
      vi.useRealTimers(); // Use real timers for this mutation-based test

      const onMissing = vi.fn().mockResolvedValue(null);

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      });

      root.innerHTML = '<p>Hello</p>';
      i18n.start();

      const p = root.querySelector('p')!;
      expect(p.textContent).toBe('Hola');

      // Simulate framework re-render: reset to original text
      p.removeAttribute('data-i18n-original');
      p.textContent = 'Hello';

      // Wait for MutationObserver to fire
      await new Promise((r) => setTimeout(r, 10));

      // Should be re-translated from cache
      expect(p.textContent).toBe('Hola');

      i18n.stop();
      vi.useFakeTimers(); // Restore for afterEach
    });

    it('should re-translate when a framework patches the text node in place (characterData)', async () => {
      vi.useRealTimers();

      const onMissing = vi.fn().mockResolvedValue(null);

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        initialCache: { 'Hello': 'Hola', 'Goodbye': 'Adiós' },
        rootElement: root,
      });

      root.innerHTML = '<p>Hello</p>';
      i18n.start();

      const p = root.querySelector('p')!;
      expect(p.textContent).toBe('Hola');

      // Vue-style in-place patch: mutate the existing text node's data
      (p.firstChild as Text).data = 'Goodbye';

      await new Promise((r) => setTimeout(r, 50));

      expect(p.textContent).toBe('Adiós');
      expect(p.getAttribute('data-i18n-original')).toBe('Goodbye');

      i18n.stop();
      vi.useFakeTimers();
    });

    it('should re-translate when a framework replaces textContent after translation (childList)', async () => {
      vi.useRealTimers();

      const onMissing = vi.fn().mockResolvedValue(null);

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        initialCache: { 'Hello': 'Hola', 'Goodbye': 'Adiós' },
        rootElement: root,
      });

      root.innerHTML = '<p>Hello</p>';
      i18n.start();

      const p = root.querySelector('p')!;
      expect(p.textContent).toBe('Hola');

      // Framework re-render: element keeps data-i18n-original, text is replaced
      p.textContent = 'Goodbye';

      await new Promise((r) => setTimeout(r, 50));

      expect(p.textContent).toBe('Adiós');
      expect(p.getAttribute('data-i18n-original')).toBe('Goodbye');

      i18n.stop();
      vi.useFakeTimers();
    });

    it('should re-translate when a framework patches a translated attribute', async () => {
      vi.useRealTimers();

      const onMissing = vi.fn().mockResolvedValue(null);

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        initialCache: { 'Enter name': 'Ingrese nombre', 'Enter email': 'Ingrese correo' },
        rootElement: root,
      });

      root.innerHTML = '<input placeholder="Enter name" />';
      i18n.start();

      const input = root.querySelector('input')!;
      expect(input.getAttribute('placeholder')).toBe('Ingrese nombre');

      input.setAttribute('placeholder', 'Enter email');

      await new Promise((r) => setTimeout(r, 50));

      expect(input.getAttribute('placeholder')).toBe('Ingrese correo');
      expect(input.getAttribute('data-i18n-original-placeholder')).toBe('Enter email');

      i18n.stop();
      vi.useFakeTimers();
    });

    it('should not overwrite patched content with a stale pending translation', async () => {
      vi.useRealTimers();

      let resolveFirst!: (v: Record<string, string>) => void;
      const first = new Promise<Record<string, string>>((res) => {
        resolveFirst = res;
      });
      const onMissing = vi.fn()
        .mockImplementationOnce(() => first) // 'Hello' batch — held open
        .mockImplementation(async () => ({ 'Goodbye': 'Adiós' }));

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        debounceTime: 30,
      });

      root.innerHTML = '<p>Hello</p>';
      i18n.start();

      // Let the debounce fire; the 'Hello' request is now in flight
      await new Promise((r) => setTimeout(r, 60));
      expect(onMissing).toHaveBeenCalledTimes(1);

      const p = root.querySelector('p')!;
      p.textContent = 'Goodbye'; // patched while 'Hello' is still pending

      // Second batch resolves 'Goodbye' → 'Adiós'
      await new Promise((r) => setTimeout(r, 80));
      expect(p.textContent).toBe('Adiós');

      // The stale 'Hello' resolution arrives late — must not clobber the newer content
      resolveFirst({ 'Hello': 'Bonjour' });
      await new Promise((r) => setTimeout(r, 20));

      expect(p.textContent).toBe('Adiós');

      i18n.stop();
      vi.useFakeTimers();
    });

    it('should not re-enqueue its own translated output (inline-tag echo)', async () => {
      vi.useRealTimers();

      const onMissing = vi.fn().mockResolvedValue({
        'Click <a0>here</a0>': 'Clic <a0>aquí</a0>',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        debounceTime: 30,
      });

      root.innerHTML = '<p>Click <a href="/x">here</a></p>';
      i18n.start();

      // Translation + echo mutations + another full debounce window
      await new Promise((r) => setTimeout(r, 150));

      expect(root.querySelector('p')!.textContent).toBe('Clic aquí');
      expect(onMissing).toHaveBeenCalledTimes(1);

      i18n.stop();
      vi.useFakeTimers();
    });
  });

  describe('debug mode', () => {
    it('should include debug info in onMissingTranslation items when debug=true', async () => {
      const onMissing = vi.fn().mockResolvedValue({ 'Hello': 'Hola' });

      root.innerHTML = '<p>Hello</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        debug: true,
      });

      i18n.start();
      await flushDebounce();

      expect(onMissing).toHaveBeenCalledTimes(1);
      const item = onMissing.mock.calls[0]![0][0]!;
      expect(item.debug).toBeDefined();
      expect(item.debug.elementOpenTag).toBe('<p>');
      expect(item.debug.source).toBe('text');
    });

    it('should not include debug info when debug is not set', async () => {
      const onMissing = vi.fn().mockResolvedValue({ 'Hello': 'Hola' });

      root.innerHTML = '<p>Hello</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      i18n.start();
      await flushDebounce();

      expect(onMissing).toHaveBeenCalledTimes(1);
      const item = onMissing.mock.calls[0]![0][0]!;
      expect(item.debug).toBeUndefined();
    });
  });

  describe('ICU MessageFormat flow', () => {
    it('should evaluate ICU plural from backend response', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        '{{0}} sheep': '{0, plural, one {# oveja} other {# ovejas}}',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<p>5 sheep</p>';
      i18n.start();

      await flushDebounce();

      expect(root.querySelector('p')!.textContent).toBe('5 ovejas');

      i18n.stop();
    });

    it('should evaluate ICU singular from backend response', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        '{{0}} sheep': '{0, plural, one {# oveja} other {# ovejas}}',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      root.innerHTML = '<p>1 sheep</p>';
      i18n.start();

      await flushDebounce();

      expect(root.querySelector('p')!.textContent).toBe('1 oveja');

      i18n.stop();
    });

    it('should evaluate ICU select with ignoreWord metadata', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        '{{0}} bought {{1}} sheep': '{0_gender, select, female {{0} compró} other {{0} compró}} {1, plural, one {# oveja} other {# ovejas}}',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }],
        rootElement: root,
      });

      root.innerHTML = '<p>Mary bought 5 sheep</p>';
      i18n.start();

      await flushDebounce();

      expect(root.querySelector('p')!.textContent).toBe('Mary compró 5 ovejas');

      i18n.stop();
    });

    it('should fall back to simple {{N}} substitution for non-ICU translations', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        '{{0}} has {{1}} cats': '{{0}} tiene {{1}} gatos',
      });

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        ignoreWords: ['John'],
        rootElement: root,
      });

      root.innerHTML = '<p>John has 3 cats</p>';
      i18n.start();

      await flushDebounce();

      expect(root.querySelector('p')!.textContent).toBe('John tiene 3 gatos');

      i18n.stop();
    });
  });

  describe('scope support', () => {
    it('should translate elements in different scopes with different translations', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Submit': { checkout: 'Finalizar compra', settings: 'Guardar' },
      });

      root.innerHTML = `
        <section data-i18n-scope="checkout"><p>Submit</p></section>
        <section data-i18n-scope="settings"><p>Submit</p></section>
      `;

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      i18n.start();
      await flushDebounce();

      const ps = root.querySelectorAll('p');
      expect(ps[0]!.textContent).toBe('Finalizar compra');
      expect(ps[1]!.textContent).toBe('Guardar');

      i18n.stop();
    });

    it('should use string response for all scopes', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Hello': 'Hola',
      });

      root.innerHTML = `
        <section data-i18n-scope="checkout"><p>Hello</p></section>
        <div><p>Hello</p></div>
      `;

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      i18n.start();
      await flushDebounce();

      const ps = root.querySelectorAll('p');
      expect(ps[0]!.textContent).toBe('Hola');
      expect(ps[1]!.textContent).toBe('Hola');

      i18n.stop();
    });

    it('should include scope in onMissingTranslation items', async () => {
      const onMissing = vi.fn().mockResolvedValue({ 'Submit': 'Enviar' });

      root.innerHTML = '<section data-i18n-scope="checkout"><p>Submit</p></section>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });

      i18n.start();
      await flushDebounce();

      expect(onMissing).toHaveBeenCalledTimes(1);
      const item = onMissing.mock.calls[0]![0][0]!;
      expect(item.scope).toBe('checkout');

      i18n.stop();
    });

    it('should work with scoped initialCache', () => {
      root.innerHTML = `
        <section data-i18n-scope="checkout"><p>Submit</p></section>
        <section data-i18n-scope="settings"><p>Submit</p></section>
      `;

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: vi.fn().mockResolvedValue(null),
        initialCache: { 'Submit': { checkout: 'Finalizar compra', settings: 'Guardar' } },
        rootElement: root,
      });

      i18n.start();

      const ps = root.querySelectorAll('p');
      expect(ps[0]!.textContent).toBe('Finalizar compra');
      expect(ps[1]!.textContent).toBe('Guardar');

      i18n.stop();
    });
  });

  describe('batch size enforcement', () => {
    it('should split large batches according to maxBatchSize', async () => {
      const onMissing = vi.fn().mockResolvedValue({});

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        maxBatchSize: 5,
        rootElement: root,
      });

      // Add 12 unique text elements (no numbers to avoid masking collisions)
      const words = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
        'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'];
      for (const word of words) {
        const p = document.createElement('p');
        p.textContent = word;
        root.appendChild(p);
      }

      i18n.start();
      await flushDebounce();

      // Should be called 3 times: 5, 5, 2
      expect(onMissing).toHaveBeenCalledTimes(3);
      expect(onMissing.mock.calls[0]![0]).toHaveLength(5);
      expect(onMissing.mock.calls[1]![0]).toHaveLength(5);
      expect(onMissing.mock.calls[2]![0]).toHaveLength(2);

      i18n.stop();
    });
  });

  describe('flush-time ignore guard (portal race)', () => {
    // Was onMissingTranslation ever called with an item for `original`?
    function reportedOriginals(onMissing: ReturnType<typeof vi.fn>): string[] {
      return onMissing.mock.calls.flatMap(
        (call) => (call[0] as TranslationItem[]).map((item) => item.original)
      );
    }

    it('should NOT report text that moved under an ignore subtree before flush', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      // Present at start: collected (visible, not ignored) by the initial scan and
      // enqueued for the next debounced flush.
      root.innerHTML = '<p>Portalled option</p>';
      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });
      i18n.start();
      const p = root.querySelector('p')!;
      expect(p.hasAttribute('data-i18n-pending')).toBe(true);

      // The framework settles it under an ignore wrapper before the debounce fires.
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-i18n-ignore', '');
      root.appendChild(wrapper);
      wrapper.appendChild(p);

      await flushDebounce();

      expect(reportedOriginals(onMissing)).not.toContain('Portalled option');

      i18n.stop();
    });

    it('should NOT report an attribute that became ignored before flush', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<input placeholder="Filter results" />';
      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });
      i18n.start();
      const input = root.querySelector('input')!;

      // Ancestor gains the ignore attribute after the value was collected.
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-i18n-ignore', '');
      root.appendChild(wrapper);
      wrapper.appendChild(input);

      await flushDebounce();

      expect(reportedOriginals(onMissing)).not.toContain('Filter results');

      i18n.stop();
    });

    it('should NOT report text detached from the document before flush', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<p>Transient tooltip</p>';
      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });
      i18n.start();
      const p = root.querySelector('p')!;

      // The portal unmounts (closes) before the debounce fires.
      p.remove();

      await flushDebounce();

      expect(reportedOriginals(onMissing)).not.toContain('Transient tooltip');

      i18n.stop();
    });

    it('should still report a normal, visible, non-ignored missing string', async () => {
      const onMissing = vi.fn().mockResolvedValue({ 'Keep me visible': 'Mantenme visible' });
      root.innerHTML = '<p>Keep me visible</p>';
      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
      });
      i18n.start();
      const p = root.querySelector('p')!;

      await flushDebounce();

      expect(reportedOriginals(onMissing)).toContain('Keep me visible');
      expect(p.textContent).toBe('Mantenme visible');

      i18n.stop();
    });

    it('should report a string on a later flush after it was dropped when ignored', async () => {
      // Round 2 inserts a genuinely new node after start(), so its collection
      // goes through the MutationObserver — unreliable to drive under fake timers
      // (see the "dynamically added element attributes" test above). Use real
      // timers and wall-clock waits, as that test does.
      vi.useRealTimers();

      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<p>Now you see me</p>';
      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        debounceTime: 50,
      });
      i18n.start();

      // Round 1: collected visible by the initial scan, then moved under ignore
      // before the debounce fires → dropped by the flush guard.
      const p1 = root.querySelector('p')!;
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-i18n-ignore', '');
      root.appendChild(wrapper);
      wrapper.appendChild(p1);

      await new Promise((r) => setTimeout(r, 150));
      expect(reportedOriginals(onMissing)).not.toContain('Now you see me');

      // Round 2: the same string later appears as a genuinely visible, non-ignored
      // node. The drop must not have left it stuck pending, or the Translator would
      // short-circuit collection and it could never be reported again.
      const p2 = document.createElement('p');
      p2.textContent = 'Now you see me';
      root.appendChild(p2);

      await new Promise((r) => setTimeout(r, 200));
      expect(reportedOriginals(onMissing)).toContain('Now you see me');

      i18n.stop();
      vi.useFakeTimers();
    });
  });

  describe('ignored descendants in an aggregated sentence', () => {
    // A distinct bug from the flush-time portal guard above: an aggregation
    // target that is NOT itself ignored but has an ignored *descendant* used to
    // fold that descendant's (user-data) text into the translatable unit. It
    // must instead be masked as an opaque variable and restored verbatim.

    // The single reported item for the first flush.
    function firstItem(onMissing: ReturnType<typeof vi.fn>): TranslationItem {
      return (onMissing.mock.calls[0]![0] as TranslationItem[])[0]!;
    }

    it('masks an attribute-ignored child as a variable and restores it verbatim', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Submitted By: {{0}}': 'Enviado por: {{0}}',
      });
      root.innerHTML =
        '<div>Submitted By: <span class="font-bold" data-i18n-ignore>Kailey Booth</span></div>';
      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      const item = firstItem(onMissing);
      expect(item.masked).toBe('Submitted By: {{0}}');
      expect(item.masked).not.toContain('Kailey');
      // The opaque slot round-trips as a variable; the original stays clean markup.
      expect(item.variables).toHaveLength(1);
      expect(item.variables[0]!.type).toBe('ignored');
      expect(item.original).not.toContain('\uE000'); // no aggregation sentinels leak
      expect(item.original).not.toContain('\uE001');
      expect(item.original).toContain('Kailey Booth');
      expect(item.variables[0]!.value).toContain('Kailey Booth');

      const div = root.querySelector('div')!;
      expect(div.textContent).toBe('Enviado por: Kailey Booth');
      const span = div.querySelector('span')!;
      expect(span.getAttribute('data-i18n-ignore')).toBe('');
      expect(span.textContent).toBe('Kailey Booth');

      i18n.stop();
    });

    it('masks a selector-ignored child the same way', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Signed by {{0}}': 'Firmado por {{0}}',
      });
      root.innerHTML = '<div>Signed by <span class="username">jbooth</span></div>';
      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        ignoreSelectors: ['.username'],
      });
      i18n.start();
      await flushDebounce();

      const item = firstItem(onMissing);
      expect(item.masked).toBe('Signed by {{0}}');
      expect(item.masked).not.toContain('jbooth');
      expect(item.variables[0]!.type).toBe('ignored');

      const div = root.querySelector('div')!;
      expect(div.textContent).toBe('Firmado por jbooth');
      expect(div.querySelector('.username')!.textContent).toBe('jbooth');

      i18n.stop();
    });

    it('keeps a translatable inline child a marker while the ignored one is a variable', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Please <b0>read</b0> this {{0}}': 'Por favor <b0>lea</b0> esto {{0}}',
      });
      root.innerHTML =
        '<div>Please <b>read</b> this <span data-i18n-ignore>Kailey</span></div>';
      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      const item = firstItem(onMissing);
      expect(item.masked).toBe('Please <b0>read</b0> this {{0}}');
      expect(item.masked).not.toContain('Kailey');

      const div = root.querySelector('div')!;
      expect(div.querySelector('b')!.textContent).toBe('lea');
      expect(div.querySelector('span[data-i18n-ignore]')!.textContent).toBe('Kailey');
      expect(div.textContent).toBe('Por favor lea esto Kailey');

      i18n.stop();
    });

    it('gives multiple ignored children stable, ordered variable slots', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'From {{0}} to {{1}}': 'De {{0}} a {{1}}',
      });
      root.innerHTML =
        '<div>From <span data-i18n-ignore>Alice</span> to <span data-i18n-ignore>Bob</span></div>';
      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      const item = firstItem(onMissing);
      expect(item.masked).toBe('From {{0}} to {{1}}');
      expect(item.variables).toHaveLength(2);
      expect(item.variables.every((v) => v.type === 'ignored')).toBe(true);

      const div = root.querySelector('div')!;
      // Each slot reinserted in its own place, in order.
      expect(div.textContent).toBe('De Alice a Bob');
      const spans = div.querySelectorAll('span[data-i18n-ignore]');
      expect(spans[0]!.textContent).toBe('Alice');
      expect(spans[1]!.textContent).toBe('Bob');

      i18n.stop();
    });

    it('treats a nested ignored subtree as a single opaque slot', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Owner: {{0}}': 'Propietario: {{0}}',
      });
      root.innerHTML =
        '<div>Owner: <span data-i18n-ignore>Name <b>Booth</b> Jr.</span></div>';
      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      const item = firstItem(onMissing);
      // The masker does NOT descend into the ignored subtree: one variable, and
      // the nested <b> is not a separate structural marker.
      expect(item.masked).toBe('Owner: {{0}}');
      expect(item.variables).toHaveLength(1);
      expect(item.variables[0]!.value).toContain('<b>Booth</b>');

      const div = root.querySelector('div')!;
      expect(div.querySelector('span[data-i18n-ignore] b')!.textContent).toBe('Booth');
      expect(div.textContent).toBe('Propietario: Name Booth Jr.');

      i18n.stop();
    });

    it('preserves the ignored child\'s live DOM node (and its listeners) on apply', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Hi {{0}}': 'Hola {{0}}',
      });
      root.innerHTML = '<div>Hi <span data-i18n-ignore>there</span></div>';
      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();

      const span = root.querySelector('span[data-i18n-ignore]')! as HTMLElement;
      const clicks = vi.fn();
      span.addEventListener('click', clicks);

      await flushDebounce();

      // Same node instance survived the morph — not reconstructed from innerHTML.
      expect(root.querySelector('span[data-i18n-ignore]')).toBe(span);
      span.dispatchEvent(new Event('click'));
      expect(clicks).toHaveBeenCalledTimes(1);

      i18n.stop();
    });

    it('leaves an ordinary inline-only sentence unchanged (no ignored variables)', async () => {
      const onMissing = vi.fn().mockResolvedValue({
        'Hello <b0>bold</b0> world': 'Hola <b0>negrita</b0> mundo',
      });
      root.innerHTML = '<p>Hello <b>bold</b> world</p>';
      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      const item = firstItem(onMissing);
      expect(item.masked).toBe('Hello <b0>bold</b0> world');
      expect(item.variables.some((v) => v.type === 'ignored')).toBe(false);
      expect(root.querySelector('p')!.innerHTML).toBe('Hola <b>negrita</b> mundo');

      i18n.stop();
    });

    it('does not report a sentence that is only punctuation once ignored slots are removed', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<div>: <span data-i18n-ignore>Kailey Booth</span></div>';
      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      expect(onMissing).not.toHaveBeenCalled();
      // Untouched, so the ignored user data is still on screen verbatim.
      expect(root.querySelector('div')!.textContent).toBe(': Kailey Booth');

      i18n.stop();
    });
  });

  describe('half-rendered values', () => {
    function firstItem(onMissing: ReturnType<typeof vi.fn>): TranslationItem {
      return (onMissing.mock.calls[0]![0] as TranslationItem[])[0]!;
    }

    it('does not report a mask holding a value that failed to render', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<p>Level undefined</p>';

      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      expect(onMissing).not.toHaveBeenCalled();
      // Nothing to translate to — the text stays as the component painted it.
      expect(root.querySelector('p')!.textContent).toBe('Level undefined');
      expect(root.querySelector('p')!.hasAttribute('data-i18n-pending')).toBe(false);

      i18n.stop();
    });

    it('reports the real mask once the component re-renders with data', async () => {
      // Mutation-driven: real timers, as elsewhere in this file.
      vi.useRealTimers();

      const onMissing = vi.fn().mockResolvedValue({ 'Level {{0}}': 'Nivel {{0}}' });
      root.innerHTML = '<p>Level undefined</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        debounceTime: 10,
      });
      i18n.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(onMissing).not.toHaveBeenCalled();

      // The data arrives and the component repaints: a different mask, which reports
      // normally — the skip left nothing behind that could suppress it.
      const p = root.querySelector('p')!;
      p.textContent = 'Level 3';
      await new Promise((r) => setTimeout(r, 50));

      expect(onMissing).toHaveBeenCalledTimes(1);
      expect(firstItem(onMissing).masked).toBe('Level {{0}}');
      expect(p.textContent).toBe('Nivel 3');

      i18n.stop();
      vi.useFakeTimers();
    });

    it('skips NaN, null and empty-quote renderings', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML =
        '<p>Read time about NaN minutes</p>' +
        '<p>Owner is null</p>' +
        "<p>No Encyclopedia results found for ''</p>" +
        '<p>Only real copy here</p>';

      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      expect(onMissing).toHaveBeenCalledTimes(1);
      expect(onMissing.mock.calls[0]![0].map((i: TranslationItem) => i.masked)).toEqual(['Only real copy here']);

      i18n.stop();
    });

    it('does not report a half-rendered attribute value', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<img alt="Photo of undefined">';

      const i18n = new I18nObserver({ locale: 'es', onMissingTranslation: onMissing, rootElement: root });
      i18n.start();
      await flushDebounce();

      expect(onMissing).not.toHaveBeenCalled();

      i18n.stop();
    });

    it('still reports half-rendered masks when skipUnrenderedValues is false', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<p>Level undefined</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        skipUnrenderedValues: false,
      });
      i18n.start();
      await flushDebounce();

      expect(onMissing).toHaveBeenCalledTimes(1);
      expect(firstItem(onMissing).masked).toBe('Level undefined');

      i18n.stop();
    });

    it('honors a custom isUnrenderedValue predicate', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      // A corpus whose copy legitimately says "null": only "undefined" is an artifact.
      const isUnrenderedValue = vi.fn((masked: string) => /\bundefined\b/.test(masked));
      root.innerHTML = '<p>Owner is null</p><p>Level undefined</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        isUnrenderedValue,
      });
      i18n.start();
      await flushDebounce();

      expect(onMissing).toHaveBeenCalledTimes(1);
      expect(onMissing.mock.calls[0]![0].map((i: TranslationItem) => i.masked)).toEqual(['Owner is null']);
      expect(isUnrenderedValue).toHaveBeenCalledWith('Level undefined', 'Level undefined');

      i18n.stop();
    });

    it('applies a cached translation for a half-rendered key rather than dropping it', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<p>Level undefined</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        initialCache: { 'Level undefined': 'Nivel desconocido' },
      });
      i18n.start();
      await flushDebounce();

      expect(onMissing).not.toHaveBeenCalled();
      expect(root.querySelector('p')!.textContent).toBe('Nivel desconocido');

      i18n.stop();
    });

    it('does not report a half-rendered mask on locale switch', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      root.innerHTML = '<p>Level undefined</p><img alt="Photo of undefined">';

      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: onMissing,
        rootElement: root,
        // Cached in es, so both units get translated and tracked — which is what
        // brings them back through the re-translate (report) path on a locale switch.
        initialCache: {
          'Level undefined': 'Nivel desconocido',
          'Photo of undefined': 'Foto de desconocido',
        },
      });
      i18n.start();
      await flushDebounce();

      i18n.setLocale('fr');
      await flushDebounce();

      expect(onMissing).not.toHaveBeenCalled();

      i18n.stop();
    });
  });

  describe('pending node retention', () => {
    // Keys the consumer was asked about but declined to translate can never be applied
    // (applyPending only runs for keys the callback returned). Tracking their nodes
    // just pins detached DOM in memory for the life of the page.
    function pendingCount(i18n: I18nObserver): number {
      return (i18n as unknown as { translator: { pendingNodeCount: number } })
        .translator.pendingNodeCount;
    }

    it('releases tracked nodes for keys the callback declined to translate', async () => {
      // Translates one of the two strings; declines the other.
      const onMissing = vi.fn<(items: TranslationItem[], locale: string) => Promise<Record<string, string> | null>>()
        .mockResolvedValue({ 'Hello': 'Hola' });

      root.innerHTML = '<p>Hello</p><p>Goodbye</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        rootElement: root,
        onMissingTranslation: onMissing,
      });
      i18n.start();
      await flushDebounce();

      expect(root.querySelector('p')?.textContent).toBe('Hola');
      // 'Hello' drained by applyPending; 'Goodbye' declined, so nothing will ever
      // apply it — it must not stay tracked.
      expect(pendingCount(i18n)).toBe(0);

      i18n.stop();
    });

    it('does not re-track a declined key as it re-renders', async () => {
      const onMissing = vi.fn<(items: TranslationItem[], locale: string) => Promise<Record<string, string> | null>>()
        .mockResolvedValue({});

      root.innerHTML = '<p>Goodbye</p>';

      const i18n = new I18nObserver({
        locale: 'es',
        rootElement: root,
        onMissingTranslation: onMissing,
      });
      i18n.start();
      await flushDebounce();

      expect(pendingCount(i18n)).toBe(0);

      // The same untranslated string churns through many mounts/unmounts.
      for (let i = 0; i < 30; i++) {
        const p = document.createElement('p');
        p.textContent = 'Goodbye';
        root.appendChild(p);
        await waitForMutations();
        p.remove();
        await waitForMutations();
      }
      await flushDebounce();

      expect(pendingCount(i18n)).toBe(0);
      // And it was only ever reported once — no infinite re-queuing.
      expect(onMissing).toHaveBeenCalledTimes(1);

      i18n.stop();
    });
  });
});
