import { describe, it, expect, vi, beforeEach } from 'vitest';
import { I18nObserver } from '../src/I18nObserver';
import type { I18nConfig, TranslationItem } from '../src/types';

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

    it('should load variant objects from initialCache', () => {
      const variant = { male: 'Bienvenido', female: 'Bienvenida' };
      const config = createConfig({
        initialCache: { 'Welcome': variant },
      });
      const i18n = new I18nObserver(config);
      expect(i18n.getTranslation('Welcome')).toEqual(variant);
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
  });

  describe('setTranslation()', () => {
    it('should load translations into cache', () => {
      const i18n = new I18nObserver(createConfig());
      i18n.setTranslation('es', { 'Hello': 'Hola', 'Bye': 'Adiós' });

      expect(i18n.getTranslation('Hello')).toBe('Hola');
      expect(i18n.getTranslation('Bye')).toBe('Adiós');
    });

    it('should work for variant objects', () => {
      const i18n = new I18nObserver(createConfig());
      const variant = { male: 'Bienvenido', female: 'Bienvenida' };
      i18n.setTranslation('es', { 'Welcome': variant });

      expect(i18n.getTranslation('Welcome')).toEqual(variant);
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

    it('should resolve variants based on context', () => {
      const i18n = new I18nObserver(createConfig({
        context: { gender: 'female' },
        initialCache: {
          'Welcome': { male: 'Bienvenido', female: 'Bienvenida' },
        },
      }));
      expect(i18n.translate('Welcome')).toBe('Bienvenida');
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

  describe('setContext()', () => {
    it('should replace context and re-resolve variants', () => {
      root.innerHTML = '<p>Welcome</p>';
      const i18n = new I18nObserver(createConfig({
        context: { gender: 'male' },
        initialCache: {
          'Welcome': { male: 'Bienvenido', female: 'Bienvenida' },
        },
        rootElement: root,
      }));

      i18n.start();
      expect(root.querySelector('p')?.textContent).toBe('Bienvenido');

      i18n.setContext({ gender: 'female' });

      expect(root.querySelector('p')?.textContent).toBe('Bienvenida');

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
