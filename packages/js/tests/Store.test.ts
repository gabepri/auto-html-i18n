import { describe, it, expect } from 'vitest';
import { Store } from '../src/Store';

function createStore(): Store {
  return new Store();
}

describe('Store', () => {
  describe('basic CRUD', () => {
    it('should return undefined for unknown key', () => {
      const store = createStore();
      expect(store.get('es', 'Hello')).toBeUndefined();
    });

    it('should store and retrieve a string translation', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      const entry = store.get('es', 'Hello');
      expect(entry).toBeDefined();
      expect(entry!.value).toBe('Hola');
      expect(entry!.status).toBe('resolved');
    });

    it('should overwrite existing entry', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.set('es', 'Hello', 'Hola!');
      expect(store.get('es', 'Hello')!.value).toBe('Hola!');
    });

    it('should report has() correctly', () => {
      const store = createStore();
      expect(store.has('es', 'Hello')).toBe(false);
      store.set('es', 'Hello', 'Hola');
      expect(store.has('es', 'Hello')).toBe(true);
    });
  });

  describe('status lifecycle', () => {
    it('should mark entry as pending', () => {
      const store = createStore();
      store.markPending('es', 'Hello');
      const entry = store.get('es', 'Hello');
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('pending');
      expect(entry!.value).toBeNull();
    });

    it('should not overwrite resolved entry with pending', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.markPending('es', 'Hello');
      const entry = store.get('es', 'Hello');
      expect(entry!.status).toBe('resolved');
      expect(entry!.value).toBe('Hola');
    });

    it('should transition from pending to resolved via set()', () => {
      const store = createStore();
      store.markPending('es', 'Hello');
      expect(store.get('es', 'Hello')!.status).toBe('pending');
      store.set('es', 'Hello', 'Hola');
      expect(store.get('es', 'Hello')!.status).toBe('resolved');
    });

    it('should mark entry as reported', () => {
      const store = createStore();
      store.markPending('es', 'Hello');
      store.markReported('es', 'Hello');
      expect(store.get('es', 'Hello')!.status).toBe('reported');
    });

    it('markReported is a no-op for a key that was never stored', () => {
      const store = createStore();
      // No locale map at all.
      expect(() => store.markReported('es', 'Hello')).not.toThrow();
      expect(store.get('es', 'Hello')).toBeUndefined();
      // Locale map exists, but not this key.
      store.markPending('es', 'Other');
      expect(() => store.markReported('es', 'Hello')).not.toThrow();
      expect(store.get('es', 'Hello')).toBeUndefined();
      expect(store.get('es', 'Other')!.status).toBe('pending');
    });

    it('resetIfPending drops pending and reported entries', () => {
      const store = createStore();
      store.markPending('es', 'Hello');
      store.resetIfPending('es', 'Hello');
      expect(store.has('es', 'Hello')).toBe(false);

      store.markPending('es', 'Hello');
      store.markReported('es', 'Hello');
      store.resetIfPending('es', 'Hello');
      expect(store.has('es', 'Hello')).toBe(false);
    });

    it('resetIfPending leaves resolved entries and unknown keys alone', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.resetIfPending('es', 'Hello');
      expect(store.get('es', 'Hello')!.value).toBe('Hola');
      expect(store.get('es', 'Hello')!.status).toBe('resolved');

      // Key absent from an existing locale map, and a locale map that doesn't exist.
      expect(() => store.resetIfPending('es', 'Nope')).not.toThrow();
      expect(() => store.resetIfPending('fr', 'Nope')).not.toThrow();
      expect(store.has('es', 'Nope')).toBe(false);
    });

    it('isPending returns true only for pending entries', () => {
      const store = createStore();
      expect(store.isPending('es', 'Hello')).toBe(false);
      store.markPending('es', 'Hello');
      expect(store.isPending('es', 'Hello')).toBe(true);
      store.set('es', 'Hello', 'Hola');
      expect(store.isPending('es', 'Hello')).toBe(false);
    });

    it('isResolved returns true only for resolved entries', () => {
      const store = createStore();
      expect(store.isResolved('es', 'Hello')).toBe(false);
      store.markPending('es', 'Hello');
      expect(store.isResolved('es', 'Hello')).toBe(false);
      store.set('es', 'Hello', 'Hola');
      expect(store.isResolved('es', 'Hello')).toBe(true);
    });
  });

  describe('locale isolation', () => {
    it('should keep entries separate per locale', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.set('fr', 'Hello', 'Bonjour');
      expect(store.get('es', 'Hello')!.value).toBe('Hola');
      expect(store.get('fr', 'Hello')!.value).toBe('Bonjour');
    });

    it('should not leak entries between locales', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      expect(store.get('fr', 'Hello')).toBeUndefined();
    });
  });

  describe('getCache()', () => {
    it('should return snapshot of resolved entries only', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.set('es', 'Bye', 'Adiós');
      const cache = store.getCache('es');
      expect(cache).toEqual({ Hello: 'Hola', Bye: 'Adiós' });
    });

    it('should not include pending entries', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.markPending('es', 'Bye');
      const cache = store.getCache('es');
      expect(cache).toEqual({ Hello: 'Hola' });
    });

    it('should return empty object for unknown locale', () => {
      const store = createStore();
      expect(store.getCache('xx')).toEqual({});
    });

    it('should return a snapshot, not a reference', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      const cache1 = store.getCache('es');
      store.set('es', 'Bye', 'Adiós');
      const cache2 = store.getCache('es');
      expect(cache1).toEqual({ Hello: 'Hola' });
      expect(cache2).toEqual({ Hello: 'Hola', Bye: 'Adiós' });
    });
  });

  describe('clearCache()', () => {
    it('should clear a specific locale', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.set('fr', 'Hello', 'Bonjour');
      store.clearCache('es');
      expect(store.get('es', 'Hello')).toBeUndefined();
      expect(store.get('fr', 'Hello')!.value).toBe('Bonjour');
    });

    it('should clear all locales when no argument', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.set('fr', 'Hello', 'Bonjour');
      store.clearCache();
      expect(store.get('es', 'Hello')).toBeUndefined();
      expect(store.get('fr', 'Hello')).toBeUndefined();
    });

    it('should not affect other locales when clearing one', () => {
      const store = createStore();
      store.set('es', 'Hello', 'Hola');
      store.set('fr', 'Hello', 'Bonjour');
      store.clearCache('es');
      expect(store.getCache('fr')).toEqual({ Hello: 'Bonjour' });
    });
  });

  describe('scoped translation entries', () => {
    it('should store and retrieve a scoped translation object', () => {
      const store = createStore();
      store.set('es', 'Submit', { checkout: 'Finalizar compra', settings: 'Guardar' });
      const entry = store.get('es', 'Submit');
      expect(entry).toBeDefined();
      expect(entry!.value).toEqual({ checkout: 'Finalizar compra', settings: 'Guardar' });
      expect(entry!.status).toBe('resolved');
    });

    it('should include scoped entries in getCache', () => {
      const store = createStore();
      store.set('es', 'Submit', { checkout: 'Finalizar compra' });
      store.set('es', 'Hello', 'Hola');
      const cache = store.getCache('es');
      expect(cache).toEqual({
        Submit: { checkout: 'Finalizar compra' },
        Hello: 'Hola',
      });
    });

    it('should load scoped entries via loadBulk', () => {
      const store = createStore();
      store.loadBulk('es', {
        Submit: { checkout: 'Finalizar compra', settings: 'Guardar' },
        Hello: 'Hola',
      });
      expect(store.get('es', 'Submit')!.value).toEqual({ checkout: 'Finalizar compra', settings: 'Guardar' });
      expect(store.get('es', 'Hello')!.value).toBe('Hola');
    });
  });

  describe('loadBulk()', () => {
    it('should load multiple entries at once', () => {
      const store = createStore();
      store.loadBulk('es', {
        Hello: 'Hola',
        Bye: 'Adiós',
      });
      expect(store.get('es', 'Hello')!.value).toBe('Hola');
      expect(store.get('es', 'Bye')!.value).toBe('Adiós');
    });

    it('should mark all loaded entries as resolved', () => {
      const store = createStore();
      store.loadBulk('es', { Hello: 'Hola' });
      expect(store.isResolved('es', 'Hello')).toBe(true);
    });

    it('should overwrite pending entries with resolved', () => {
      const store = createStore();
      store.markPending('es', 'Hello');
      expect(store.isPending('es', 'Hello')).toBe(true);
      store.loadBulk('es', { Hello: 'Hola' });
      expect(store.isResolved('es', 'Hello')).toBe(true);
      expect(store.get('es', 'Hello')!.value).toBe('Hola');
    });

  });
});
