import { describe, it, expect } from 'vitest';
import { Resolver } from '../src/Resolver';
import type { ResolverConfig } from '../src/types';

const defaultConfig: ResolverConfig = {
  context: { gender: 'female', formality: 'formal' },
  fallbackContext: { gender: 'neutral', formality: 'neutral' },
  contextOrder: ['gender', 'formality'],
};

function createResolver(overrides: Partial<ResolverConfig> = {}): Resolver {
  return new Resolver({ ...defaultConfig, ...overrides });
}

describe('Resolver', () => {
  describe('resolve() with string entry', () => {
    it('should return the string directly', () => {
      const resolver = createResolver();
      expect(resolver.resolve('Hola')).toBe('Hola');
    });
  });

  describe('resolve() with variant object', () => {
    it('should match exact compound key first', () => {
      const resolver = createResolver();
      const entry = {
        female_formal: 'A',
        female: 'B',
        formal: 'C',
      };
      expect(resolver.resolve(entry)).toBe('A');
    });

    it('should fall back to first partial match (first context dimension)', () => {
      const resolver = createResolver();
      const entry = {
        female: 'B',
        formal: 'C',
      };
      expect(resolver.resolve(entry)).toBe('B');
    });

    it('should fall back to second partial match', () => {
      const resolver = createResolver();
      const entry = {
        formal: 'C',
        male: 'D',
      };
      expect(resolver.resolve(entry)).toBe('C');
    });

    it('should use fallback context when current context fails', () => {
      const resolver = createResolver({
        context: { gender: 'other', formality: 'other' },
        fallbackContext: { gender: 'neutral', formality: 'neutral' },
      });
      const entry = {
        male: 'A',
        neutral: 'B',
      };
      expect(resolver.resolve(entry)).toBe('B');
    });

    it('should try fallback compound key', () => {
      const resolver = createResolver({
        context: { gender: 'other', formality: 'other' },
        fallbackContext: { gender: 'neutral', formality: 'neutral' },
      });
      const entry = {
        neutral_neutral: 'A',
        neutral: 'B',
      };
      expect(resolver.resolve(entry)).toBe('A');
    });

    it('should return first available value if no candidates match', () => {
      const resolver = createResolver({
        context: { gender: 'other', formality: 'other' },
        fallbackContext: { gender: 'none', formality: 'none' },
      });
      const entry = {
        male: 'A',
        female: 'B',
      };
      expect(resolver.resolve(entry)).toBe('A');
    });

    it('should return null for empty variant object', () => {
      const resolver = createResolver();
      expect(resolver.resolve({})).toBeNull();
    });
  });

  describe('getCandidateKeys()', () => {
    it('should return keys in correct priority order', () => {
      const resolver = createResolver();
      const keys = resolver.getCandidateKeys();
      expect(keys).toEqual([
        'female_formal',
        'female',
        'formal',
        'neutral_neutral',
        'neutral',
      ]);
    });

    it('should handle single context dimension', () => {
      const resolver = createResolver({
        context: { gender: 'female' },
        fallbackContext: { gender: 'neutral' },
        contextOrder: ['gender'],
      });
      const keys = resolver.getCandidateKeys();
      expect(keys).toEqual(['female', 'neutral']);
    });

    it('should handle empty context', () => {
      const resolver = createResolver({
        context: {},
        fallbackContext: { gender: 'neutral' },
        contextOrder: ['gender'],
      });
      const keys = resolver.getCandidateKeys();
      expect(keys).toEqual(['neutral']);
    });

    it('should deduplicate candidate keys', () => {
      const resolver = createResolver({
        context: { gender: 'neutral', formality: 'neutral' },
        fallbackContext: { gender: 'neutral', formality: 'neutral' },
        contextOrder: ['gender', 'formality'],
      });
      const keys = resolver.getCandidateKeys();
      // Should not have duplicates
      expect(keys).toEqual([...new Set(keys)]);
      expect(keys).toContain('neutral_neutral');
      expect(keys).toContain('neutral');
    });

    it('should handle three context dimensions', () => {
      const resolver = createResolver({
        context: { gender: 'male', formality: 'formal', tone: 'friendly' },
        fallbackContext: { gender: 'neutral', formality: 'neutral', tone: 'neutral' },
        contextOrder: ['gender', 'formality', 'tone'],
      });
      const keys = resolver.getCandidateKeys();
      expect(keys[0]).toBe('male_formal_friendly');
      expect(keys).toContain('male');
      expect(keys).toContain('formal');
      expect(keys).toContain('friendly');
    });
  });

  describe('updateContext()', () => {
    it('should change resolution behavior after update', () => {
      const resolver = createResolver({
        context: { gender: 'female' },
        fallbackContext: { gender: 'neutral' },
        contextOrder: ['gender'],
      });
      const entry = { female: 'A', male: 'B' };
      expect(resolver.resolve(entry)).toBe('A');

      resolver.updateContext({ gender: 'male' });
      expect(resolver.resolve(entry)).toBe('B');
    });

    it('should update candidate keys', () => {
      const resolver = createResolver({
        context: { gender: 'female' },
        fallbackContext: { gender: 'neutral' },
        contextOrder: ['gender'],
      });
      expect(resolver.getCandidateKeys()).toEqual(['female', 'neutral']);

      resolver.updateContext({ gender: 'male' });
      expect(resolver.getCandidateKeys()).toEqual(['male', 'neutral']);
    });
  });

  describe('updateFallbackContext()', () => {
    it('should change fallback resolution', () => {
      const resolver = createResolver({
        context: { gender: 'other' },
        fallbackContext: { gender: 'neutral' },
        contextOrder: ['gender'],
      });
      const entry = { neutral: 'A', default: 'B' };
      expect(resolver.resolve(entry)).toBe('A');

      resolver.updateFallbackContext({ gender: 'default' });
      expect(resolver.resolve(entry)).toBe('B');
    });
  });
});
