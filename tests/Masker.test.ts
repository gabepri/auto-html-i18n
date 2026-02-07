import { describe, it, expect } from 'vitest';
import { Masker } from '../src/Masker';
import type { MaskerConfig } from '../src/types';

const defaultConfig: MaskerConfig = {
  ignoreWords: [],
  allowedInlineTags: ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del'],
};

function createMasker(overrides: Partial<MaskerConfig> = {}): Masker {
  return new Masker({ ...defaultConfig, ...overrides });
}

describe('Masker', () => {
  describe('mask() - variable masking', () => {
    it('should mask standalone numbers', () => {
      const masker = createMasker();
      const result = masker.mask('You have 5 apples');
      expect(result.masked).toBe('You have {{0}} apples');
      expect(result.variables).toEqual(['5']);
    });

    it('should mask multiple numbers in order', () => {
      const masker = createMasker();
      const result = masker.mask('Page 3 of 10');
      expect(result.masked).toBe('Page {{0}} of {{1}}');
      expect(result.variables).toEqual(['3', '10']);
    });

    it('should mask decimal numbers', () => {
      const masker = createMasker();
      const result = masker.mask('Total: 19.99');
      expect(result.masked).toBe('Total: {{0}}');
      expect(result.variables).toEqual(['19.99']);
    });

    it('should mask date-like patterns (MM/DD/YYYY)', () => {
      const masker = createMasker();
      const result = masker.mask('Born on 01/15/2024');
      expect(result.masked).toBe('Born on {{0}}');
      expect(result.variables).toEqual(['01/15/2024']);
    });

    it('should mask date-like patterns with dashes', () => {
      const masker = createMasker();
      const result = masker.mask('Date: 2024-01-15');
      expect(result.masked).toBe('Date: {{0}}');
      expect(result.variables).toEqual(['2024-01-15']);
    });

    it('should mask date-like patterns with dots', () => {
      const masker = createMasker();
      const result = masker.mask('Date: 15.01.2024');
      expect(result.masked).toBe('Date: {{0}}');
      expect(result.variables).toEqual(['15.01.2024']);
    });

    it('should mask ignoreWords (case-sensitive)', () => {
      const masker = createMasker({ ignoreWords: ['Mary'] });
      const result = masker.mask('Hello Mary');
      expect(result.masked).toBe('Hello {{0}}');
      expect(result.variables).toEqual(['Mary']);
    });

    it('should not mask ignoreWords with different case', () => {
      const masker = createMasker({ ignoreWords: ['Mary'] });
      const result = masker.mask('Hello mary');
      expect(result.masked).toBe('Hello mary');
      expect(result.variables).toEqual([]);
    });

    it('should mask ignoreWords and numbers in left-to-right order', () => {
      const masker = createMasker({ ignoreWords: ['John'] });
      const result = masker.mask('John has 3 cats');
      expect(result.masked).toBe('{{0}} has {{1}} cats');
      expect(result.variables).toEqual(['John', '3']);
    });

    it('should handle multi-word ignoreWords', () => {
      const masker = createMasker({ ignoreWords: ['John Doe'] });
      const result = masker.mask('Hello John Doe');
      expect(result.masked).toBe('Hello {{0}}');
      expect(result.variables).toEqual(['John Doe']);
    });

    it('should prefer longer ignoreWords over shorter ones', () => {
      const masker = createMasker({ ignoreWords: ['John', 'John Doe'] });
      const result = masker.mask('Hello John Doe');
      expect(result.masked).toBe('Hello {{0}}');
      expect(result.variables).toEqual(['John Doe']);
    });

    it('should return original text unchanged if nothing to mask', () => {
      const masker = createMasker();
      const result = masker.mask('Hello world');
      expect(result.masked).toBe('Hello world');
      expect(result.variables).toEqual([]);
    });

    it('should handle empty string', () => {
      const masker = createMasker();
      const result = masker.mask('');
      expect(result.masked).toBe('');
      expect(result.variables).toEqual([]);
    });

    it('should handle text that is only a number', () => {
      const masker = createMasker();
      const result = masker.mask('42');
      expect(result.masked).toBe('{{0}}');
      expect(result.variables).toEqual(['42']);
    });

    it('should mask negative numbers', () => {
      const masker = createMasker();
      const result = masker.mask('Temperature is -5 degrees');
      expect(result.masked).toBe('Temperature is {{0}} degrees');
      expect(result.variables).toEqual(['-5']);
    });

    it('should mask percentages', () => {
      const masker = createMasker();
      const result = masker.mask('Progress: 85%');
      expect(result.masked).toBe('Progress: {{0}}%');
      expect(result.variables).toEqual(['85']);
    });
  });

  describe('mask() - inline tag normalization', () => {
    it('should normalize a single inline tag', () => {
      const masker = createMasker();
      const result = masker.mask('Click <a href="/login">here</a> to login');
      expect(result.masked).toBe('Click <a0>here</a0> to login');
      expect(result.tagAttributes.get('a0')).toEqual({ href: '/login' });
    });

    it('should normalize multiple tags of the same type', () => {
      const masker = createMasker();
      const result = masker.mask('<a href="/a">first</a> and <a href="/b">second</a>');
      expect(result.masked).toBe('<a0>first</a0> and <a1>second</a1>');
      expect(result.tagAttributes.get('a0')).toEqual({ href: '/a' });
      expect(result.tagAttributes.get('a1')).toEqual({ href: '/b' });
    });

    it('should normalize tags of different types', () => {
      const masker = createMasker();
      const result = masker.mask('<b class="bold">hello</b> <span>world</span>');
      expect(result.masked).toBe('<b0>hello</b0> <span0>world</span0>');
      expect(result.tagAttributes.get('b0')).toEqual({ class: 'bold' });
      expect(result.tagAttributes.get('span0')).toEqual({});
    });

    it('should strip all attributes from tag', () => {
      const masker = createMasker();
      const result = masker.mask('<a href="/test" class="link" id="foo">text</a>');
      expect(result.masked).toBe('<a0>text</a0>');
      expect(result.tagAttributes.get('a0')).toEqual({
        href: '/test',
        class: 'link',
        id: 'foo',
      });
    });

    it('should not normalize tags not in allowedInlineTags', () => {
      const masker = createMasker();
      const result = masker.mask('<div>text</div>');
      expect(result.masked).toBe('<div>text</div>');
    });

    it('should handle tags with no attributes', () => {
      const masker = createMasker();
      const result = masker.mask('<b>bold text</b>');
      expect(result.masked).toBe('<b0>bold text</b0>');
      expect(result.tagAttributes.get('b0')).toEqual({});
    });

    it('should handle nested inline tags', () => {
      const masker = createMasker();
      const result = masker.mask('<b>bold <i>and italic</i></b>');
      expect(result.masked).toBe('<b0>bold <i0>and italic</i0></b0>');
    });
  });

  describe('mask() - combined variable masking and tag normalization', () => {
    it('should mask variables inside inline tags', () => {
      const masker = createMasker({ ignoreWords: ['Mary'] });
      const result = masker.mask('Welcome <b>Mary</b>, you have 5 items');
      expect(result.masked).toBe('Welcome <b0>{{0}}</b0>, you have {{1}} items');
      expect(result.variables).toEqual(['Mary', '5']);
      expect(result.tagAttributes.get('b0')).toEqual({});
    });

    it('should handle inline tag with href and ignored word', () => {
      const masker = createMasker({ ignoreWords: ['Google'] });
      const result = masker.mask('Visit <a href="https://google.com">Google</a> for more');
      expect(result.masked).toBe('Visit <a0>{{0}}</a0> for more');
      expect(result.variables).toEqual(['Google']);
      expect(result.tagAttributes.get('a0')).toEqual({ href: 'https://google.com' });
    });
  });

  describe('unmask()', () => {
    it('should restore variables into placeholders', () => {
      const masker = createMasker();
      const result = masker.unmask('Hola {{0}}', ['Mary'], new Map());
      expect(result).toBe('Hola Mary');
    });

    it('should restore multiple variables', () => {
      const masker = createMasker();
      const result = masker.unmask('{{0}} tiene {{1}} gatos', ['John', '3'], new Map());
      expect(result).toBe('John tiene 3 gatos');
    });

    it('should restore tag attributes', () => {
      const masker = createMasker();
      const attrs = new Map([['a0', { href: '/login' }]]);
      const result = masker.unmask('<a0>aqui</a0>', [], attrs);
      expect(result).toBe('<a href="/login">aqui</a>');
    });

    it('should restore tag with multiple attributes', () => {
      const masker = createMasker();
      const attrs = new Map([['a0', { href: '/test', class: 'link' }]]);
      const result = masker.unmask('<a0>text</a0>', [], attrs);
      expect(result).toContain('href="/test"');
      expect(result).toContain('class="link"');
      expect(result).toMatch(/^<a [^>]+>text<\/a>$/);
    });

    it('should restore tag with no attributes', () => {
      const masker = createMasker();
      const attrs = new Map([['b0', {}]]);
      const result = masker.unmask('<b0>text</b0>', [], attrs);
      expect(result).toBe('<b>text</b>');
    });

    it('should restore both variables and tag attributes', () => {
      const masker = createMasker();
      const attrs = new Map([['b0', {}]]);
      const result = masker.unmask('Bienvenida <b0>{{0}}</b0>', ['Mary'], attrs);
      expect(result).toBe('Bienvenida <b>Mary</b>');
    });

    it('should strip event handler attributes during restoration', () => {
      const masker = createMasker();
      const attrs = new Map([['a0', { href: '/ok', onclick: 'alert(1)' }]]);
      const result = masker.unmask('<a0>click</a0>', [], attrs);
      expect(result).toContain('href="/ok"');
      expect(result).not.toContain('onclick');
    });

    it('should strip all on* attributes', () => {
      const masker = createMasker();
      const attrs = new Map([
        ['a0', { href: '/ok', onerror: 'alert(1)', onload: 'x()', onmouseover: 'y()' }],
      ]);
      const result = masker.unmask('<a0>click</a0>', [], attrs);
      expect(result).toContain('href="/ok"');
      expect(result).not.toContain('onerror');
      expect(result).not.toContain('onload');
      expect(result).not.toContain('onmouseover');
    });

    it('should handle missing variables gracefully', () => {
      const masker = createMasker();
      const result = masker.unmask('Hello {{0}} {{1}}', ['World'], new Map());
      expect(result).toBe('Hello World {{1}}');
    });

    it('should handle empty input', () => {
      const masker = createMasker();
      const result = masker.unmask('', [], new Map());
      expect(result).toBe('');
    });
  });

  describe('unmask() - tag allowlist sanitization', () => {
    it('should escape script tags in translated output', () => {
      const masker = createMasker();
      const result = masker.unmask('Hello <script>alert(1)</script>', [], new Map());
      expect(result).toBe('Hello &lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('should escape iframe tags in translated output', () => {
      const masker = createMasker();
      const result = masker.unmask('See <iframe src="evil.com"></iframe>', [], new Map());
      expect(result).toBe('See &lt;iframe src="evil.com"&gt;&lt;/iframe&gt;');
    });

    it('should escape img tags in translated output', () => {
      const masker = createMasker();
      const result = masker.unmask('Image: <img src=x onerror=alert(1)>', [], new Map());
      expect(result).toBe('Image: &lt;img src=x onerror=alert(1)&gt;');
    });

    it('should escape div tags in translated output', () => {
      const masker = createMasker();
      const result = masker.unmask('Text <div>inside div</div>', [], new Map());
      expect(result).toBe('Text &lt;div&gt;inside div&lt;/div&gt;');
    });

    it('should preserve allowed tags while escaping disallowed ones', () => {
      const masker = createMasker();
      const attrs = new Map([['b0', {}]]);
      const result = masker.unmask('<b0>bold</b0> <script>evil</script>', [], attrs);
      expect(result).toBe('<b>bold</b> &lt;script&gt;evil&lt;/script&gt;');
    });

    it('should allow all configured inline tags through', () => {
      const masker = createMasker();
      const attrs = new Map<string, Record<string, string>>([
        ['a0', { href: '/test' }],
        ['strong0', {}],
        ['em0', {}],
      ]);
      const result = masker.unmask('<a0>link</a0> <strong0>bold</strong0> <em0>italic</em0>', [], attrs);
      expect(result).toBe('<a href="/test">link</a> <strong>bold</strong> <em>italic</em>');
    });

    it('should escape form tags in translated output', () => {
      const masker = createMasker();
      const result = masker.unmask('<form action="/steal"><input type="text"></form>', [], new Map());
      expect(result).toContain('&lt;form');
      expect(result).toContain('&lt;input');
    });
  });

  describe('roundtrip: mask then unmask', () => {
    it('should roundtrip simple text with numbers', () => {
      const masker = createMasker();
      const original = 'You have 5 apples and 3 oranges';
      const { masked, variables, tagAttributes } = masker.mask(original);
      const restored = masker.unmask(masked, variables, tagAttributes);
      expect(restored).toBe(original);
    });

    it('should roundtrip text with inline tags', () => {
      const masker = createMasker();
      const original = 'Click <a href="/login">here</a> to login';
      const { masked, variables, tagAttributes } = masker.mask(original);
      // Simulate translation that preserves structure
      const translated = masked; // identity "translation"
      const restored = masker.unmask(translated, variables, tagAttributes);
      expect(restored).toBe(original);
    });

    it('should roundtrip text with ignoreWords and tags', () => {
      const masker = createMasker({ ignoreWords: ['Mary'] });
      const original = 'Welcome <b>Mary</b>, you have 5 items';
      const { masked, variables, tagAttributes } = masker.mask(original);
      const restored = masker.unmask(masked, variables, tagAttributes);
      expect(restored).toBe(original);
    });
  });
});
