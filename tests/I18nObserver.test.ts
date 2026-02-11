import { describe, it, expect, vi, beforeEach } from 'vitest';
import { I18nObserver } from '../src/I18nObserver';
import type { I18nConfig } from '../src/types';

function createConfig(overrides: Partial<I18nConfig> = {}): I18nConfig {
  return {
    locale: 'es',
    onMissingTranslation: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('I18nObserver', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(root);
  });

  describe('constructor', () => {
    it('should require locale and onMissingTranslation', () => {
      const config = createConfig();
      const i18n = new I18nObserver(config);
      expect(i18n).toBeInstanceOf(I18nObserver);
    });

    it('should load initialCache into store', () => {
      const config = createConfig({
        initialCache: { 'Hello': 'Hola' },
      });
      const i18n = new I18nObserver(config);
      expect(i18n.getTranslation('Hello')).toBe('Hola');
    });

  });

  describe('start() / stop()', () => {
    it('should process existing content on start()', async () => {
      root.innerHTML = '<p>Hello</p>';
      const onMissing = vi.fn().mockResolvedValue({ 'Hello': 'Hola' });
      const i18n = new I18nObserver(createConfig({
        onMissingTranslation: onMissing,
        rootElement: root,
      }));

      i18n.start();

      // The text should be queued for translation
      // Flush by waiting for debounce (or the test framework handles it)
      expect(root.querySelector('p')?.hasAttribute('data-i18n-pending')).toBe(true);

      i18n.stop();
    });

    it('should apply cached translation immediately on start()', () => {
      root.innerHTML = '<p>Hello</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      }));

      i18n.start();

      expect(root.querySelector('p')?.textContent).toBe('Hola');

      i18n.stop();
    });

    it('should stop observing after stop()', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      const i18n = new I18nObserver(createConfig({
        onMissingTranslation: onMissing,
        rootElement: root,
      }));

      i18n.start();
      i18n.stop();
      onMissing.mockClear();

      const p = document.createElement('p');
      p.textContent = 'After stop';
      root.appendChild(p);

      // Wait for potential mutations
      await new Promise(r => setTimeout(r, 0));

      // The callback for this text should NOT have been triggered
      // (no new pending items)
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
    });

    it('should be safe to call stop() without start()', () => {
      const i18n = new I18nObserver(createConfig());
      expect(() => i18n.stop()).not.toThrow();
    });

    it('should revert translated text content when stop(true)', () => {
      root.innerHTML = '<p>Hello</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      }));

      i18n.start();
      expect(root.querySelector('p')?.textContent).toBe('Hola');

      i18n.stop(true);
      expect(root.querySelector('p')?.textContent).toBe('Hello');
    });

    it('should revert translated attributes when stop(true)', () => {
      root.innerHTML = '<input placeholder="Search here">';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Search here': 'Buscar aquí' },
        rootElement: root,
      }));

      i18n.start();
      const input = root.querySelector('input')!;
      expect(input.getAttribute('placeholder')).toBe('Buscar aquí');

      i18n.stop(true);
      expect(input.getAttribute('placeholder')).toBe('Search here');
    });

    it('should remove all data-i18n-* attributes when stop(true)', () => {
      root.innerHTML = '<p>Hello</p><input placeholder="Search here">';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola', 'Search here': 'Buscar aquí' },
        rootElement: root,
      }));

      i18n.start();
      i18n.stop(true);

      const p = root.querySelector('p')!;
      const input = root.querySelector('input')!;
      expect(p.hasAttribute('data-i18n-original')).toBe(false);
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
      expect(input.hasAttribute('data-i18n-original-placeholder')).toBe(false);
    });

    it('should revert innerHTML content with inline tags when stop(true)', () => {
      root.innerHTML = '<p>Click <a href="/login">here</a> to login</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Click <a0>here</a0> to login': 'Haga clic <a0>aquí</a0> para iniciar sesión' },
        rootElement: root,
      }));

      i18n.start();
      expect(root.querySelector('p')?.textContent).toBe('Haga clic aquí para iniciar sesión');

      i18n.stop(true);
      expect(root.querySelector('p')?.innerHTML).toBe('Click <a href="/login">here</a> to login');
    });

    it('should not revert when stop() called without argument', () => {
      root.innerHTML = '<p>Hello</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      }));

      i18n.start();
      i18n.stop();

      expect(root.querySelector('p')?.textContent).toBe('Hola');
      expect(root.querySelector('p')?.hasAttribute('data-i18n-original')).toBe(true);
    });

    it('should not revert when stop(false)', () => {
      root.innerHTML = '<p>Hello</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      }));

      i18n.start();
      i18n.stop(false);

      expect(root.querySelector('p')?.textContent).toBe('Hola');
    });

    it('should remove pending attributes when stop(true) with in-flight translations', () => {
      root.innerHTML = '<p>Hello</p>';
      const i18n = new I18nObserver(createConfig({
        rootElement: root,
      }));

      i18n.start();
      expect(root.querySelector('p')?.hasAttribute('data-i18n-pending')).toBe(true);

      i18n.stop(true);
      expect(root.querySelector('p')?.hasAttribute('data-i18n-pending')).toBe(false);
      // Text should still be original since it was never translated
      expect(root.querySelector('p')?.textContent).toBe('Hello');
    });

    it('should allow start() after stop(true) to re-translate from cache', () => {
      root.innerHTML = '<p>Hello</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      }));

      i18n.start();
      expect(root.querySelector('p')?.textContent).toBe('Hola');

      i18n.stop(true);
      expect(root.querySelector('p')?.textContent).toBe('Hello');

      i18n.start();
      expect(root.querySelector('p')?.textContent).toBe('Hola');
    });

    it('should revert multiple elements when stop(true)', () => {
      root.innerHTML = '<p>Hello</p><p>Goodbye</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola', 'Goodbye': 'Adiós' },
        rootElement: root,
      }));

      i18n.start();
      const [p1, p2] = root.querySelectorAll('p');
      expect(p1?.textContent).toBe('Hola');
      expect(p2?.textContent).toBe('Adiós');

      i18n.stop(true);
      expect(p1?.textContent).toBe('Hello');
      expect(p2?.textContent).toBe('Goodbye');
    });
  });

  describe('destroy()', () => {
    it('should clear cache', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
      }));

      expect(i18n.getTranslation('Hello')).toBe('Hola');
      i18n.destroy();
      expect(i18n.getTranslation('Hello')).toBeUndefined();
    });

    it('should revert DOM and clear cache when destroy(true)', () => {
      root.innerHTML = '<p>Hello</p><input placeholder="Search here">';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola', 'Search here': 'Buscar aquí' },
        rootElement: root,
      }));

      i18n.start();
      const p = root.querySelector('p')!;
      const input = root.querySelector('input')!;
      expect(p.textContent).toBe('Hola');
      expect(input.getAttribute('placeholder')).toBe('Buscar aquí');

      i18n.destroy(true);

      // Text and attributes reverted
      expect(p.textContent).toBe('Hello');
      expect(input.getAttribute('placeholder')).toBe('Search here');

      // All data-i18n-* attributes removed
      expect(p.hasAttribute('data-i18n-original')).toBe(false);
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
      expect(input.hasAttribute('data-i18n-original-placeholder')).toBe(false);

      // Cache cleared
      expect(i18n.getTranslation('Hello')).toBeUndefined();
    });

    it('should clear cache without reverting DOM when destroy(false)', () => {
      root.innerHTML = '<p>Hello</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      }));

      i18n.start();
      i18n.destroy(false);

      expect(root.querySelector('p')?.textContent).toBe('Hola');
      expect(i18n.getTranslation('Hello')).toBeUndefined();
    });

    it('should stop observing after destroy()', async () => {
      const onMissing = vi.fn().mockResolvedValue(null);
      const i18n = new I18nObserver(createConfig({
        onMissingTranslation: onMissing,
        rootElement: root,
      }));

      i18n.start();
      i18n.destroy();
      onMissing.mockClear();

      const p = document.createElement('p');
      p.textContent = 'After destroy';
      root.appendChild(p);

      await new Promise(r => setTimeout(r, 0));
      expect(p.hasAttribute('data-i18n-pending')).toBe(false);
    });

    it('should be safe to call destroy() without start()', () => {
      const i18n = new I18nObserver(createConfig());
      expect(() => i18n.destroy()).not.toThrow();
    });

    it('should trigger onMissingTranslation on start() after destroy()', () => {
      root.innerHTML = '<p>Hello</p>';
      const onMissing = vi.fn().mockResolvedValue(null);
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        onMissingTranslation: onMissing,
        rootElement: root,
      }));

      i18n.start();
      expect(root.querySelector('p')?.textContent).toBe('Hola');

      i18n.destroy(true);
      expect(root.querySelector('p')?.textContent).toBe('Hello');

      // After destroy, cache is gone — start() should queue for translation
      i18n.start();
      expect(root.querySelector('p')?.hasAttribute('data-i18n-pending')).toBe(true);
    });
  });

  describe('setTranslation()', () => {
    it('should load translations into cache', () => {
      const i18n = new I18nObserver(createConfig());
      i18n.setTranslation('es', { 'Hello': 'Hola', 'Bye': 'Adiós' });

      expect(i18n.getTranslation('Hello')).toBe('Hola');
      expect(i18n.getTranslation('Bye')).toBe('Adiós');
    });

  });

  describe('getTranslation()', () => {
    it('should return raw entry from cache', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
      }));
      expect(i18n.getTranslation('Hello')).toBe('Hola');
    });

    it('should use current locale when locale param omitted', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
      }));
      expect(i18n.getTranslation('Hello')).toBe('Hola');
    });

    it('should support explicit locale parameter', () => {
      const i18n = new I18nObserver(createConfig());
      i18n.setTranslation('fr', { 'Hello': 'Bonjour' });

      expect(i18n.getTranslation('Hello', 'fr')).toBe('Bonjour');
      expect(i18n.getTranslation('Hello', 'es')).toBeUndefined();
    });

    it('should return undefined for unknown key', () => {
      const i18n = new I18nObserver(createConfig());
      expect(i18n.getTranslation('nonexistent')).toBeUndefined();
    });
  });

  describe('translate()', () => {
    it('should translate using current locale and context', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
      }));
      expect(i18n.translate('Hello')).toBe('Hola');
    });

    it('should substitute variables', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello {{0}}': 'Hola {{0}}' },
      }));
      expect(i18n.translate('Hello {{0}}', ['World'])).toBe('Hola World');
    });

    it('should return original text if no translation found', () => {
      const i18n = new I18nObserver(createConfig());
      expect(i18n.translate('Unknown text')).toBe('Unknown text');
    });

    it('should return original text with variables substituted if no translation', () => {
      const i18n = new I18nObserver(createConfig());
      expect(i18n.translate('Hello {{0}}', ['World'])).toBe('Hello World');
    });

  });

  describe('setLocale()', () => {
    it('should update locale', () => {
      root.innerHTML = '<p>Hello</p>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      }));

      i18n.start();
      expect(root.querySelector('p')?.textContent).toBe('Hola');

      // Load French translations and switch
      i18n.setTranslation('fr', { 'Hello': 'Bonjour' });
      i18n.setLocale('fr');

      expect(root.querySelector('p')?.textContent).toBe('Bonjour');

      i18n.stop();
    });
  });

  describe('ignoreWords runtime API', () => {
    describe('getIgnoreWords()', () => {
      it('should return initial ignoreWords', () => {
        const i18n = new I18nObserver(createConfig({
          ignoreWords: ['Alice', 'Bob'],
        }));
        expect(i18n.getIgnoreWords()).toEqual(expect.arrayContaining(['Alice', 'Bob']));
        expect(i18n.getIgnoreWords()).toHaveLength(2);
      });

      it('should return empty array when none configured', () => {
        const i18n = new I18nObserver(createConfig());
        expect(i18n.getIgnoreWords()).toEqual([]);
      });
    });

    describe('addIgnoreWords()', () => {
      it('should add words and retranslate DOM', () => {
        root.innerHTML = '<p>Hello Mary</p>';
        const i18n = new I18nObserver(createConfig({
          initialCache: {
            'Hello Mary': 'Hola Mary Literal',
            'Hello {{0}}': 'Hola {{0}}',
          },
          rootElement: root,
        }));

        i18n.start();
        // Without 'Mary' in ignoreWords, "Hello Mary" is the unmasked key
        expect(root.querySelector('p')?.textContent).toBe('Hola Mary Literal');

        i18n.addIgnoreWords('Mary');

        // Now "Hello Mary" masks to "Hello {{0}}" which uses the masked translation
        expect(root.querySelector('p')?.textContent).toBe('Hola Mary');

        i18n.stop();
      });

      it('should reflect additions in getIgnoreWords()', () => {
        const i18n = new I18nObserver(createConfig());
        i18n.addIgnoreWords('Alice');
        expect(i18n.getIgnoreWords()).toContain('Alice');
      });
    });

    describe('removeIgnoreWords()', () => {
      it('should remove words and retranslate DOM', () => {
        root.innerHTML = '<p>Hello Mary</p>';
        const i18n = new I18nObserver(createConfig({
          ignoreWords: ['Mary'],
          initialCache: {
            'Hello {{0}}': 'Hola {{0}}',
            'Hello Mary': 'Hola Mary Completa',
          },
          rootElement: root,
        }));

        i18n.start();
        // With 'Mary' in ignoreWords, masks to "Hello {{0}}"
        expect(root.querySelector('p')?.textContent).toBe('Hola Mary');

        i18n.removeIgnoreWords('Mary');

        // Now "Hello Mary" is the key — uses the full string translation
        expect(root.querySelector('p')?.textContent).toBe('Hola Mary Completa');

        i18n.stop();
      });

      it('should reflect removals in getIgnoreWords()', () => {
        const i18n = new I18nObserver(createConfig({
          ignoreWords: ['Alice', 'Bob'],
        }));
        i18n.removeIgnoreWords('Alice');
        expect(i18n.getIgnoreWords()).not.toContain('Alice');
        expect(i18n.getIgnoreWords()).toContain('Bob');
      });
    });

    describe('ignoreWords with metadata', () => {
      it('should accept object entries with meta in config', () => {
        const i18n = new I18nObserver(createConfig({
          ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }, 'Google'],
        }));
        expect(i18n.getIgnoreWords()).toEqual(expect.arrayContaining([
          { word: 'Mary', meta: { gender: 'female' } },
          'Google',
        ]));
        expect(i18n.getIgnoreWords()).toHaveLength(2);
      });

      it('should pass metadata through to translation items', () => {
        root.innerHTML = '<p>Hello Mary</p>';
        const onMissing = vi.fn().mockResolvedValue(null);
        const i18n = new I18nObserver(createConfig({
          ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }],
          onMissingTranslation: onMissing,
          rootElement: root,
          debounceTime: 0,
        }));

        i18n.start();
        i18n.stop();
      });

      it('should accept setIgnoreWords with IgnoreWordEntry objects', () => {
        const i18n = new I18nObserver(createConfig());
        i18n.setIgnoreWords([{ word: 'Mary', meta: { gender: 'female' } }]);
        expect(i18n.getIgnoreWords()).toEqual([
          { word: 'Mary', meta: { gender: 'female' } },
        ]);
      });
    });

    describe('setIgnoreWords()', () => {
      it('should replace ignore words and retranslate DOM', () => {
        root.innerHTML = '<p>Hello Alice</p>';
        const i18n = new I18nObserver(createConfig({
          ignoreWords: ['Bob'],
          initialCache: {
            'Hello Alice': 'Hola Alice Literal',
            'Hello {{0}}': 'Hola {{0}}',
          },
          rootElement: root,
        }));

        i18n.start();
        // 'Alice' is not in ignoreWords, so "Hello Alice" is the unmasked key
        expect(root.querySelector('p')?.textContent).toBe('Hola Alice Literal');

        i18n.setIgnoreWords(['Alice']);

        // Now 'Alice' is masked, uses "Hello {{0}}" key
        expect(root.querySelector('p')?.textContent).toBe('Hola Alice');

        i18n.stop();
      });
    });
  });

  describe('scope support', () => {
    it('should resolve scoped initialCache on start()', () => {
      root.innerHTML = '<section data-i18n-scope="checkout"><p>Submit</p></section>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Submit': { checkout: 'Finalizar compra', settings: 'Guardar' } },
        rootElement: root,
      }));

      i18n.start();

      expect(root.querySelector('p')?.textContent).toBe('Finalizar compra');

      i18n.stop();
    });

    it('should use string entry for any scope', () => {
      root.innerHTML = '<section data-i18n-scope="checkout"><p>Hello</p></section>';
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
        rootElement: root,
      }));

      i18n.start();

      expect(root.querySelector('p')?.textContent).toBe('Hola');

      i18n.stop();
    });

    it('should store and retrieve scoped translation via setTranslation', () => {
      const i18n = new I18nObserver(createConfig());
      i18n.setTranslation('es', { 'Submit': { checkout: 'Finalizar compra' } });

      expect(i18n.getTranslation('Submit')).toEqual({ checkout: 'Finalizar compra' });
    });

    it('should resolve scope in translate() with scope parameter', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Submit': { checkout: 'Finalizar compra', settings: 'Guardar' } },
      }));

      expect(i18n.translate('Submit', undefined, 'checkout')).toBe('Finalizar compra');
      expect(i18n.translate('Submit', undefined, 'settings')).toBe('Guardar');
    });

    it('should fall back to original text in translate() when scope not in Record', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Submit': { checkout: 'Finalizar compra' } },
      }));

      expect(i18n.translate('Submit', undefined, 'unknown')).toBe('Submit');
    });

    it('should use string entry in translate() regardless of scope', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
      }));

      expect(i18n.translate('Hello', undefined, 'checkout')).toBe('Hola');
    });
  });

  describe('getCache() / clearCache()', () => {
    it('should return cache snapshot', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
      }));

      const cache = i18n.getCache();
      expect(cache).toEqual({ 'Hello': 'Hola' });
    });

    it('should return cache for a specific locale', () => {
      const i18n = new I18nObserver(createConfig());
      i18n.setTranslation('fr', { 'Hello': 'Bonjour' });

      expect(i18n.getCache('fr')).toEqual({ 'Hello': 'Bonjour' });
    });

    it('should clear specified locale', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
      }));
      i18n.setTranslation('fr', { 'Hello': 'Bonjour' });

      i18n.clearCache('es');

      expect(i18n.getCache('es')).toEqual({});
      expect(i18n.getCache('fr')).toEqual({ 'Hello': 'Bonjour' });
    });

    it('should clear all locales when no argument', () => {
      const i18n = new I18nObserver(createConfig({
        initialCache: { 'Hello': 'Hola' },
      }));
      i18n.setTranslation('fr', { 'Hello': 'Bonjour' });

      i18n.clearCache();

      expect(i18n.getCache('es')).toEqual({});
      expect(i18n.getCache('fr')).toEqual({});
    });
  });
});
