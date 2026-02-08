import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { I18nObserver } from '../src/I18nObserver';
import type { I18nConfig, TranslationItem } from '../src/types';

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

    it('should handle polymorphic translation with context switching', async () => {
      const i18n = new I18nObserver({
        locale: 'es',
        onMissingTranslation: vi.fn().mockResolvedValue(null),
        context: { gender: 'male' },
        initialCache: {
          'Welcome': { male: 'Bienvenido', female: 'Bienvenida' },
        },
        rootElement: root,
      });

      root.innerHTML = '<p>Welcome</p>';
      i18n.start();

      expect(root.querySelector('p')!.textContent).toBe('Bienvenido');

      // Switch context — no network request
      i18n.setContext({ gender: 'female' });

      expect(root.querySelector('p')!.textContent).toBe('Bienvenida');

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
      expect(item.variables).toEqual(['John', '3']);

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
});
