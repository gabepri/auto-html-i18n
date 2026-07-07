import { describe, it, expect } from 'vitest';
import { Masker } from '../src/Masker';
import type { MaskerConfig, VariableInfo } from '../src/types';

const defaultConfig: MaskerConfig = {
  ignoreWords: [],
  allowedInlineTags: ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del'],
};

function createMasker(overrides: Partial<MaskerConfig> = {}): Masker {
  return new Masker({ ...defaultConfig, ...overrides });
}

/** Helper to build a VariableInfo for concise assertions */
function v(value: string, type: VariableInfo['type'], meta?: Record<string, string>): VariableInfo {
  const info: VariableInfo = { value, type };
  if (meta) info.meta = meta;
  return info;
}

describe('Masker', () => {
  describe('mask() - variable masking', () => {
    it('should mask standalone numbers', () => {
      const masker = createMasker();
      const result = masker.mask('You have 5 apples');
      expect(result.masked).toBe('You have {{0}} apples');
      expect(result.variables).toEqual([v('5', 'number')]);
    });

    it('should mask multiple numbers in order', () => {
      const masker = createMasker();
      const result = masker.mask('Page 3 of 10');
      expect(result.masked).toBe('Page {{0}} of {{1}}');
      expect(result.variables).toEqual([v('3', 'number'), v('10', 'number')]);
    });

    it('should mask decimal numbers', () => {
      const masker = createMasker();
      const result = masker.mask('Total: 19.99');
      expect(result.masked).toBe('Total: {{0}}');
      expect(result.variables).toEqual([v('19.99', 'number')]);
    });

    it('should mask date-like patterns (MM/DD/YYYY)', () => {
      const masker = createMasker();
      const result = masker.mask('Born on 01/15/2024');
      expect(result.masked).toBe('Born on {{0}}');
      expect(result.variables).toEqual([v('01/15/2024', 'date')]);
    });

    it('should mask date-like patterns with dashes', () => {
      const masker = createMasker();
      const result = masker.mask('Date: 2024-01-15');
      expect(result.masked).toBe('Date: {{0}}');
      expect(result.variables).toEqual([v('2024-01-15', 'date')]);
    });

    it('should mask date-like patterns with dots', () => {
      const masker = createMasker();
      const result = masker.mask('Date: 15.01.2024');
      expect(result.masked).toBe('Date: {{0}}');
      expect(result.variables).toEqual([v('15.01.2024', 'date')]);
    });

    it('should mask ignoreWords (case-sensitive)', () => {
      const masker = createMasker({ ignoreWords: ['Mary'] });
      const result = masker.mask('Hello Mary');
      expect(result.masked).toBe('Hello {{0}}');
      expect(result.variables).toEqual([v('Mary', 'ignoreWord')]);
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
      expect(result.variables).toEqual([v('John', 'ignoreWord'), v('3', 'number')]);
    });

    it('should handle multi-word ignoreWords', () => {
      const masker = createMasker({ ignoreWords: ['John Doe'] });
      const result = masker.mask('Hello John Doe');
      expect(result.masked).toBe('Hello {{0}}');
      expect(result.variables).toEqual([v('John Doe', 'ignoreWord')]);
    });

    it('should prefer longer ignoreWords over shorter ones', () => {
      const masker = createMasker({ ignoreWords: ['John', 'John Doe'] });
      const result = masker.mask('Hello John Doe');
      expect(result.masked).toBe('Hello {{0}}');
      expect(result.variables).toEqual([v('John Doe', 'ignoreWord')]);
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
      expect(result.variables).toEqual([v('42', 'number')]);
    });

    it('should mask negative numbers', () => {
      const masker = createMasker();
      const result = masker.mask('Temperature is -5 degrees');
      expect(result.masked).toBe('Temperature is {{0}} degrees');
      expect(result.variables).toEqual([v('-5', 'number')]);
    });

    it('should mask percentages', () => {
      const masker = createMasker();
      const result = masker.mask('Progress: 85%');
      expect(result.masked).toBe('Progress: {{0}}{{1}}');
      expect(result.variables).toEqual([v('85', 'number'), v('%', 'symbol')]);
    });

    it('should mask the copyright symbol ©', () => {
      const masker = createMasker();
      const result = masker.mask('© 2024 Acme Inc');
      expect(result.masked).toBe('{{0}} {{1}} Acme Inc');
      expect(result.variables).toEqual([v('©', 'symbol'), v('2024', 'number')]);
    });

    it('should mask the registered trademark symbol ®', () => {
      const masker = createMasker();
      const result = masker.mask('Acme® is great');
      expect(result.masked).toBe('Acme{{0}} is great');
      expect(result.variables).toEqual([v('®', 'symbol')]);
    });

    it('should mask the trademark symbol ™', () => {
      const masker = createMasker();
      const result = masker.mask('Brand™ products');
      expect(result.masked).toBe('Brand{{0}} products');
      expect(result.variables).toEqual([v('™', 'symbol')]);
    });

    it('should mask currency symbols', () => {
      const masker = createMasker();
      const result = masker.mask('Price: €50');
      expect(result.masked).toBe('Price: {{0}}{{1}}');
      expect(result.variables).toEqual([v('€', 'symbol'), v('50', 'number')]);
    });

    it('should mask dollar sign', () => {
      const masker = createMasker();
      const result = masker.mask('Price: $30');
      expect(result.masked).toBe('Price: {{0}}{{1}}');
      expect(result.variables).toEqual([v('$', 'symbol'), v('30', 'number')]);
    });

    it('should mask percent sign', () => {
      const masker = createMasker();
      const result = masker.mask('100%');
      expect(result.masked).toBe('{{0}}{{1}}');
      expect(result.variables).toEqual([v('100', 'number'), v('%', 'symbol')]);
    });

    it('should mask multiple different symbols', () => {
      const masker = createMasker();
      const result = masker.mask('© 2024 Brand™');
      expect(result.masked).toBe('{{0}} {{1}} Brand{{2}}');
      expect(result.variables).toEqual([v('©', 'symbol'), v('2024', 'number'), v('™', 'symbol')]);
    });

    it('should mask miscellaneous symbols like § ¶ •', () => {
      const masker = createMasker();
      const result = masker.mask('See § 5 for details');
      expect(result.masked).toBe('See {{0}} {{1}} for details');
      expect(result.variables).toEqual([v('§', 'symbol'), v('5', 'number')]);
    });

    it('should mask the degree symbol °', () => {
      const masker = createMasker();
      const result = masker.mask('It is 72°F outside');
      expect(result.masked).toBe('It is {{0}}{{1}}F outside');
      expect(result.variables).toEqual([v('72', 'number'), v('°', 'symbol')]);
    });

    it('should mask the plus-minus symbol ±', () => {
      const masker = createMasker();
      const result = masker.mask('Tolerance: ±5 mm');
      expect(result.masked).toBe('Tolerance: {{0}}{{1}} mm');
      expect(result.variables).toEqual([v('±', 'symbol'), v('5', 'number')]);
    });
  });

  describe('mask() - URLs and emails', () => {
    it('should mask an https URL', () => {
      const masker = createMasker();
      const result = masker.mask('Visit https://example.com for more');
      expect(result.masked).toBe('Visit {{0}} for more');
      expect(result.variables).toEqual([v('https://example.com', 'url')]);
    });

    it('should mask an http URL', () => {
      const masker = createMasker();
      const result = masker.mask('Go to http://example.com/page');
      expect(result.masked).toBe('Go to {{0}}');
      expect(result.variables).toEqual([v('http://example.com/page', 'url')]);
    });

    it('should mask a URL with path, query, and fragment', () => {
      const masker = createMasker();
      const result = masker.mask('See https://example.com/path?q=1&b=2#section for details');
      expect(result.masked).toBe('See {{0}} for details');
      expect(result.variables).toEqual([v('https://example.com/path?q=1&b=2#section', 'url')]);
    });

    it('should mask an email address', () => {
      const masker = createMasker();
      const result = masker.mask('Contact us at support@example.com today');
      expect(result.masked).toBe('Contact us at {{0}} today');
      expect(result.variables).toEqual([v('support@example.com', 'email')]);
    });

    it('should mask email with plus and dots', () => {
      const masker = createMasker();
      const result = masker.mask('Email user.name+tag@sub.example.co.uk');
      expect(result.masked).toBe('Email {{0}}');
      expect(result.variables).toEqual([v('user.name+tag@sub.example.co.uk', 'email')]);
    });

    it('should mask both URL and email in the same text', () => {
      const masker = createMasker();
      const result = masker.mask('Visit https://example.com or email info@example.com');
      expect(result.masked).toBe('Visit {{0}} or email {{1}}');
      expect(result.variables).toEqual([v('https://example.com', 'url'), v('info@example.com', 'email')]);
    });
  });

  describe('mask() - HTML comments as variables', () => {
    it('should mask a single HTML comment', () => {
      const masker = createMasker();
      const result = masker.mask('hello <!--v-if-->');
      expect(result.masked).toBe('hello {{0}}');
      expect(result.variables).toEqual([v('<!--v-if-->', 'comment')]);
    });

    it('should mask multiple consecutive HTML comments', () => {
      const masker = createMasker();
      const result = masker.mask('text <!--v-if--><!--v-if--><!--v-if-->');
      expect(result.masked).toBe('text {{0}}{{1}}{{2}}');
      expect(result.variables).toEqual([v('<!--v-if-->', 'comment'), v('<!--v-if-->', 'comment'), v('<!--v-if-->', 'comment')]);
    });

    it('should mask comments mixed with other text', () => {
      const masker = createMasker();
      const result = masker.mask('/ exam <!--v-if--><!--v-if--><!--v-if-->');
      expect(result.masked).toBe('/ exam {{0}}{{1}}{{2}}');
      expect(result.variables).toEqual([v('<!--v-if-->', 'comment'), v('<!--v-if-->', 'comment'), v('<!--v-if-->', 'comment')]);
    });

    it('should mask comments alongside inline tags', () => {
      const masker = createMasker();
      const result = masker.mask('<span class="x">$15</span><span class="y">/ exam <!--v-if--></span>');
      expect(result.masked).toBe('<span0>{{0}}{{1}}</span0><span1>/ exam {{2}}</span1>');
      expect(result.variables).toEqual([v('$', 'symbol'), v('15', 'number'), v('<!--v-if-->', 'comment')]);
    });

    it('should mask an empty HTML comment', () => {
      const masker = createMasker();
      const result = masker.mask('text <!---->');
      expect(result.masked).toBe('text {{0}}');
      expect(result.variables).toEqual([v('<!---->', 'comment')]);
    });

    it('should mask comments with arbitrary content', () => {
      const masker = createMasker();
      const result = masker.mask('before <!-- some comment --> after');
      expect(result.masked).toBe('before {{0}} after');
      expect(result.variables).toEqual([v('<!-- some comment -->', 'comment')]);
    });

    it('should roundtrip text with HTML comments', () => {
      const masker = createMasker();
      const original = '/ exam <!--v-if--><!--v-if-->';
      const { masked, variables, tagAttributes } = masker.mask(original);
      const restored = masker.unmask(masked, variables, tagAttributes);
      expect(restored).toBe(original);
    });

    it('should roundtrip comments with inline tags', () => {
      const masker = createMasker();
      const original = '<span class="x">text</span> <!--v-if-->';
      const { masked, variables, tagAttributes } = masker.mask(original);
      const restored = masker.unmask(masked, variables, tagAttributes);
      expect(restored).toBe(original);
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

    it('should mask tags not in allowedInlineTags as opaque markup variables', () => {
      const masker = createMasker();
      const result = masker.mask('<div>text</div>');
      expect(result.masked).toBe('{{0}}text{{1}}');
      expect(result.variables).toEqual([
        { value: '<div>', type: 'markup' },
        { value: '</div>', type: 'markup' },
      ]);
    });

    it('keeps a non-allowed tag\'s volatile attributes out of the cache key', () => {
      const masker = createMasker();
      const a = masker.mask('x<input id="input_13" value="Environmental">y');
      const b = masker.mask('x<input id="input_47" value="Environmental">y');
      // Different ids must not change the key — both mask to the same masked form.
      expect(a.masked).toBe('x{{0}}y');
      expect(b.masked).toBe('x{{0}}y');
    });

    it('round-trips a masked non-allowed tag verbatim through unmask', () => {
      const masker = createMasker();
      const { masked, variables, tagAttributes } = masker.mask('See <img src="a.png"> now');
      expect(masked).toBe('See {{0}} now');
      const out = masker.unmask('See {{0}} now', variables, tagAttributes);
      expect(out).toBe('See <img src="a.png"> now');
    });

    it('matches nested same-name closing tags to their opener (stack order)', () => {
      const masker = createMasker();
      const result = masker.mask('<span>outer <span>inner</span> tail</span>');
      expect(result.masked).toBe('<span0>outer <span1>inner</span1> tail</span0>');
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
      expect(result.variables).toEqual([v('Mary', 'ignoreWord'), v('5', 'number')]);
      expect(result.tagAttributes.get('b0')).toEqual({});
    });

    it('should handle inline tag with href and ignored word', () => {
      const masker = createMasker({ ignoreWords: ['Google'] });
      const result = masker.mask('Visit <a href="https://google.com">Google</a> for more');
      expect(result.masked).toBe('Visit <a0>{{0}}</a0> for more');
      expect(result.variables).toEqual([v('Google', 'ignoreWord')]);
      expect(result.tagAttributes.get('a0')).toEqual({ href: 'https://google.com' });
    });
  });

  describe('mask() - ignoreWords with metadata', () => {
    it('should accept string entries in ignoreWords (backward compat)', () => {
      const masker = createMasker({ ignoreWords: ['Mary'] });
      const result = masker.mask('Hello Mary');
      expect(result.variables).toEqual([v('Mary', 'ignoreWord')]);
    });

    it('should accept object entries with meta', () => {
      const masker = createMasker({
        ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }],
      });
      const result = masker.mask('Hello Mary');
      expect(result.variables).toEqual([
        v('Mary', 'ignoreWord', { gender: 'female' }),
      ]);
    });

    it('should mix string and object entries', () => {
      const masker = createMasker({
        ignoreWords: [
          'Google',
          { word: 'Mary', meta: { gender: 'female' } },
        ],
      });
      const result = masker.mask('Mary uses Google');
      expect(result.variables).toEqual([
        v('Mary', 'ignoreWord', { gender: 'female' }),
        v('Google', 'ignoreWord'),
      ]);
    });

    it('should sort object entries longest-first by word', () => {
      const masker = createMasker({
        ignoreWords: [
          { word: 'Al', meta: { gender: 'male' } },
          { word: 'Alice', meta: { gender: 'female' } },
        ],
      });
      const result = masker.mask('Hello Alice');
      expect(result.variables).toEqual([
        v('Alice', 'ignoreWord', { gender: 'female' }),
      ]);
    });

    it('should preserve metadata in getIgnoreWords result', () => {
      const masker = createMasker({
        ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }, 'Google'],
      });
      expect(masker.getIgnoreWords()).toEqual(expect.arrayContaining([
        { word: 'Mary', meta: { gender: 'female' } },
        'Google',
      ]));
      expect(masker.getIgnoreWords()).toHaveLength(2);
    });

    it('should handle setIgnoreWords with object entries', () => {
      const masker = createMasker();
      masker.setIgnoreWords([{ word: 'Mary', meta: { gender: 'female' } }]);
      const result = masker.mask('Hello Mary');
      expect(result.variables).toEqual([v('Mary', 'ignoreWord', { gender: 'female' })]);
    });
  });

  describe('unmask()', () => {
    it('should restore variables into placeholders', () => {
      const masker = createMasker();
      const result = masker.unmask('Hola {{0}}', [v('Mary', 'ignoreWord')], new Map());
      expect(result).toBe('Hola Mary');
    });

    it('should restore multiple variables', () => {
      const masker = createMasker();
      const result = masker.unmask('{{0}} tiene {{1}} gatos', [v('John', 'ignoreWord'), v('3', 'number')], new Map());
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
      const result = masker.unmask('Bienvenida <b0>{{0}}</b0>', [v('Mary', 'ignoreWord')], attrs);
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
      const result = masker.unmask('Hello {{0}} {{1}}', [v('World', 'ignoreWord')], new Map());
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

  describe('unmask() - ICU MessageFormat', () => {
    it('should detect and evaluate ICU plural', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0, plural, one {# item} other {# items}}',
        [v('5', 'number')],
        new Map(),
        'en'
      );
      expect(result).toBe('5 items');
    });

    it('should evaluate ICU plural with singular', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0, plural, one {# item} other {# items}}',
        [v('1', 'number')],
        new Map(),
        'en'
      );
      expect(result).toBe('1 item');
    });

    it('should evaluate ICU with mixed variables (name + count)', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0} bought {1, plural, one {# sheep} other {# sheep}}',
        [v('Mary', 'ignoreWord'), v('5', 'number')],
        new Map(),
        'en'
      );
      expect(result).toBe('Mary bought 5 sheep');
    });

    it('should evaluate ICU select with ignoreWord metadata', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0_gender, select, female {{0} a acheté} other {{0} a acheté}} {1, plural, one {# mouton} other {# moutons}}',
        [v('Mary', 'ignoreWord', { gender: 'female' }), v('5', 'number')],
        new Map(),
        'fr'
      );
      expect(result).toBe('Mary a acheté 5 moutons');
    });

    it('should fall back to simple substitution for {{N}} format', () => {
      const masker = createMasker();
      const result = masker.unmask('Hola {{0}}', [v('Mary', 'ignoreWord')], new Map());
      expect(result).toBe('Hola Mary');
    });

    it('should apply tag attribute restoration after ICU evaluation', () => {
      const masker = createMasker();
      const attrs = new Map([['a0', { href: '/items' }]]);
      const result = masker.unmask(
        '<a0>{0, plural, one {# item} other {# items}}</a0>',
        [v('3', 'number')],
        attrs,
        'en'
      );
      expect(result).toBe('<a href="/items">3 items</a>');
    });

    it('should sanitize disallowed tags after ICU evaluation', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0, plural, one {# item} other {# items}} <script>evil</script>',
        [v('2', 'number')],
        new Map(),
        'en'
      );
      expect(result).toContain('2 items');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should handle ICU format error gracefully', () => {
      const masker = createMasker();
      // Malformed ICU without an original — falls back to raw pattern (legacy behavior)
      const result = masker.unmask(
        '{0, plural, {broken}',
        [v('5', 'number')],
        new Map(),
        'en'
      );
      expect(result).toBe('{0, plural, {broken}');
    });

    it('should fall back to the original text on ICU parse error when original is provided', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0, plural, {broken}',
        [v('5', 'number')],
        new Map(),
        'en',
        'You have 5 items'
      );
      expect(result).toBe('You have 5 items');
    });

    it('should fall back to the original text when ICU evaluation fails on missing arguments', () => {
      const masker = createMasker();
      // Pattern references {1} but only one variable exists — format() throws
      const result = masker.unmask(
        '{0} tiene {1} gatos',
        [v('John', 'ignoreWord')],
        new Map(),
        'es',
        'John has cats'
      );
      expect(result).toBe('John has cats');
    });

    it('should trim edge whitespace from the fallback original for caller re-wrapping', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0, plural, {broken}',
        [v('5', 'number')],
        new Map(),
        'en',
        '  5 items \n'
      );
      expect(result).toBe('5 items');
    });

    it('should ignore the original fallback when ICU evaluation succeeds', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('5', 'number')],
        new Map(),
        'es',
        '5 sheep'
      );
      expect(result).toBe('5 ovejas');
    });

    it('should degrade to the primary language subtag when the locale region is invalid', () => {
      const masker = createMasker();
      // 'es-41' is ill-formed BCP 47 (region subtags are 2 letters or 3 digits).
      // Rather than dropping the translation, evaluation retries with 'es' —
      // mirroring ICU4C's lenient locale fallback in the PHP port.
      const result = masker.unmask(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('5', 'number')],
        new Map(),
        'es-41',
        '5 sheep'
      );
      expect(result).toBe('5 ovejas');
    });

    it('should use the base language plural rules after locale degradation', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('1', 'number')],
        new Map(),
        'es-41',
        '1 sheep'
      );
      expect(result).toBe('1 oveja');
    });

    it('should degrade ICU-style underscore locale ids to their language', () => {
      const masker = createMasker();
      const result = masker.unmask(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('5', 'number')],
        new Map(),
        'es_419',
        '5 sheep'
      );
      expect(result).toBe('5 ovejas');
    });

    it('should still render via the universal locale when the language is also invalid', () => {
      const masker = createMasker();
      // '419' cannot even be a language subtag; the final degradation step is
      // the universal 'und' tag, so the translation still renders. Asserting
      // the count-5 case keeps this deterministic: the pattern only defines
      // one/other, and every locale maps 5 to a category that resolves to
      // 'other' here — unlike count 1, whose category at this step depends on
      // what the runtime resolves 'und' to.
      const result = masker.unmask(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('5', 'number')],
        new Map(),
        '419',
        '5 sheep'
      );
      expect(result).toBe('5 ovejas');
    });

    it('should keep rendering the translation for a wholly invalid locale (never the original)', () => {
      const masker = createMasker();
      // The exact plural category at the terminal step follows the runtime's
      // resolution of 'und', so only assert the translation was used
      const result = masker.unmask(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('1', 'number')],
        new Map(),
        '419',
        '1 sheep'
      );
      expect(result).toContain('oveja');
      expect(result).not.toBe('1 sheep');
    });
  });

  describe('validateIcu()', () => {
    it('should report a valid ICU pattern with its rendered output', () => {
      const masker = createMasker();
      const result = masker.validateIcu(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('5', 'number')],
        'es'
      );
      expect(result).toEqual({ valid: true, format: 'icu', output: '5 ovejas' });
    });

    it('should report a malformed ICU pattern as invalid with an error', () => {
      const masker = createMasker();
      const result = masker.validateIcu('{0, plural, {broken}', [v('5', 'number')], 'es');
      expect(result.valid).toBe(false);
      expect(result.format).toBe('icu');
      expect(result.error).toBeTruthy();
      expect(result.output).toBeUndefined();
    });

    it('should report an ICU pattern referencing a missing variable as invalid', () => {
      const masker = createMasker();
      const result = masker.validateIcu('{0} tiene {1} gatos', [v('John', 'ignoreWord')], 'es');
      expect(result.valid).toBe(false);
      expect(result.format).toBe('icu');
      expect(result.error).toBeTruthy();
    });

    it('should validate simple substitution and render its output', () => {
      const masker = createMasker();
      const result = masker.validateIcu(
        '{{0}} tiene {{1}} gatos',
        [v('John', 'ignoreWord'), v('3', 'number')],
        'es'
      );
      expect(result).toEqual({ valid: true, format: 'simple', output: 'John tiene 3 gatos' });
    });

    it('should report simple substitution with an out-of-range index as invalid', () => {
      const masker = createMasker();
      const result = masker.validateIcu('Hola {{2}}', [v('John', 'ignoreWord')], 'es');
      expect(result.valid).toBe(false);
      expect(result.format).toBe('simple');
      expect(result.error).toContain('{{2}}');
    });

    it('should validate plain text as plain format', () => {
      const masker = createMasker();
      const result = masker.validateIcu('Hola mundo', [], 'es');
      expect(result).toEqual({ valid: true, format: 'plain', output: 'Hola mundo' });
    });

    it('should validate with degraded locale when the region subtag is invalid', () => {
      const masker = createMasker();
      const result = masker.validateIcu(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('5', 'number')],
        'es-41'
      );
      expect(result).toEqual({ valid: true, format: 'icu', output: '5 ovejas' });
    });

    it('should validate successfully for a wholly invalid locale via the universal fallback', () => {
      const masker = createMasker();
      const result = masker.validateIcu(
        '{0, plural, one {# oveja} other {# ovejas}}',
        [v('5', 'number')],
        '419'
      );
      expect(result).toEqual({ valid: true, format: 'icu', output: '5 ovejas' });
    });
  });

  describe('validateTranslation()', () => {
    it('should derive variables from the original text exactly like consumption', () => {
      const masker = createMasker({ ignoreWords: ['John'] });
      const result = masker.validateTranslation(
        'John has 3 cats',
        '{{0}} tiene {{1}} gatos',
        'es'
      );
      expect(result).toEqual({ valid: true, format: 'simple', output: 'John tiene 3 gatos' });
    });

    it('should validate an ICU translation against the original text', () => {
      const masker = createMasker();
      const result = masker.validateTranslation(
        '5 sheep',
        '{0, plural, one {# oveja} other {# ovejas}}',
        'es'
      );
      expect(result).toEqual({ valid: true, format: 'icu', output: '5 ovejas' });
    });

    it('should report an ICU translation referencing a variable the original lacks', () => {
      const masker = createMasker({ ignoreWords: ['John'] });
      const result = masker.validateTranslation(
        'John has 3 cats',
        '{0} tiene {2} gatos',
        'es'
      );
      expect(result.valid).toBe(false);
      expect(result.format).toBe('icu');
      expect(result.error).toBeTruthy();
    });

    it('should restore inline tag attributes in the output like consumption does', () => {
      const masker = createMasker();
      const result = masker.validateTranslation(
        'Click <a href="/x">here</a>',
        'Clic <a0>aquí</a0>',
        'es'
      );
      expect(result.valid).toBe(true);
      expect(result.output).toBe('Clic <a href="/x">aquí</a>');
    });

    it('should apply the case pattern and edge whitespace like consumption does', () => {
      const masker = createMasker();
      const result = masker.validateTranslation('  CLICK HERE ', 'haz clic aquí', 'es');
      expect(result.valid).toBe(true);
      expect(result.output).toBe('  HAZ CLIC AQUÍ ');
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

  describe('mask() - case normalization', () => {
    it('should return casePattern "lower" for all-lowercase text', () => {
      const masker = createMasker();
      const result = masker.mask('hello world');
      expect(result.casePattern).toBe('lower');
      expect(result.masked).toBe('hello world');
    });

    it('should return casePattern "upper" for ALL-UPPERCASE text and lowercase the key', () => {
      const masker = createMasker();
      const result = masker.mask('HELLO WORLD');
      expect(result.casePattern).toBe('upper');
      expect(result.masked).toBe('hello world');
    });

    it('should return casePattern "mixed" for Title Case text', () => {
      const masker = createMasker();
      const result = masker.mask('Hello World');
      expect(result.casePattern).toBe('mixed');
      expect(result.masked).toBe('Hello World');
    });

    it('should detect case ignoring variable placeholders', () => {
      const masker = createMasker();
      const result = masker.mask('HELLO 123');
      expect(result.casePattern).toBe('upper');
      expect(result.masked).toBe('hello {{0}}');
    });

    it('should detect case ignoring inline tags', () => {
      const masker = createMasker();
      const result = masker.mask('<b>HELLO</b>');
      expect(result.casePattern).toBe('upper');
      expect(result.masked).toBe('<b0>hello</b0>');
    });

    it('should treat text with no letters as "lower"', () => {
      const masker = createMasker();
      const result = masker.mask('123 456');
      expect(result.casePattern).toBe('lower');
    });

    it('should detect uppercase with ignoreWords as variables', () => {
      const masker = createMasker({ ignoreWords: ['ACME'] });
      const result = masker.mask('WELCOME TO ACME');
      expect(result.casePattern).toBe('upper');
      expect(result.masked).toBe('welcome to {{0}}');
    });

    it('should share the same key for lowercase and uppercase inputs', () => {
      const masker = createMasker();
      const lower = masker.mask('hello world');
      const upper = masker.mask('HELLO WORLD');
      expect(lower.masked).toBe(upper.masked);
    });

    it('should not normalize mixed case keys', () => {
      const masker = createMasker();
      const mixed = masker.mask('Hello World');
      const lower = masker.mask('hello world');
      expect(mixed.masked).not.toBe(lower.masked);
    });

    it('should handle empty string', () => {
      const masker = createMasker();
      const result = masker.mask('');
      expect(result.casePattern).toBe('lower');
    });
  });

  describe('applyCasePattern()', () => {
    it('should uppercase plain text for "upper" pattern', () => {
      const masker = createMasker();
      expect(masker.applyCasePattern('hola mundo', 'upper')).toBe('HOLA MUNDO');
    });

    it('should return text unchanged for "lower" pattern', () => {
      const masker = createMasker();
      expect(masker.applyCasePattern('hola mundo', 'lower')).toBe('hola mundo');
    });

    it('should return text unchanged for "mixed" pattern', () => {
      const masker = createMasker();
      expect(masker.applyCasePattern('Hola Mundo', 'mixed')).toBe('Hola Mundo');
    });

    it('should uppercase text but preserve HTML tag internals', () => {
      const masker = createMasker();
      const result = masker.applyCasePattern('click <a href="/login">here</a> now', 'upper');
      expect(result).toBe('CLICK <a href="/login">HERE</a> NOW');
    });

    it('should handle text with multiple tags', () => {
      const masker = createMasker();
      const result = masker.applyCasePattern('<b>bold</b> and <i>italic</i>', 'upper');
      expect(result).toBe('<b>BOLD</b> AND <i>ITALIC</i>');
    });
  });

  describe('mask() - whitespace trimming', () => {
    it('should trim leading whitespace from the masked key', () => {
      const masker = createMasker();
      const result = masker.mask(' hello world');
      expect(result.masked).toBe('hello world');
      expect(result.leadingWhitespace).toBe(' ');
      expect(result.trailingWhitespace).toBe('');
    });

    it('should trim trailing whitespace from the masked key', () => {
      const masker = createMasker();
      const result = masker.mask('hello world  ');
      expect(result.masked).toBe('hello world');
      expect(result.leadingWhitespace).toBe('');
      expect(result.trailingWhitespace).toBe('  ');
    });

    it('should trim both leading and trailing whitespace', () => {
      const masker = createMasker();
      const result = masker.mask('  hello world  ');
      expect(result.masked).toBe('hello world');
      expect(result.leadingWhitespace).toBe('  ');
      expect(result.trailingWhitespace).toBe('  ');
    });

    it('should produce the same key with and without leading space', () => {
      const masker = createMasker();
      const withSpace = masker.mask(' hello');
      const withoutSpace = masker.mask('hello');
      expect(withSpace.masked).toBe(withoutSpace.masked);
    });

    it('should trim whitespace around masked variables', () => {
      const masker = createMasker();
      const result = masker.mask(' 1 of 3');
      expect(result.masked).toBe('{{0}} of {{1}}');
      expect(result.leadingWhitespace).toBe(' ');
    });

    it('should have empty whitespace fields when no trimming needed', () => {
      const masker = createMasker();
      const result = masker.mask('hello world');
      expect(result.leadingWhitespace).toBe('');
      expect(result.trailingWhitespace).toBe('');
    });

    it('should handle tabs and newlines as whitespace', () => {
      const masker = createMasker();
      const result = masker.mask('\n\thello world\t');
      expect(result.masked).toBe('hello world');
      expect(result.leadingWhitespace).toBe('\n\t');
      expect(result.trailingWhitespace).toBe('\t');
    });

    it('should handle empty string', () => {
      const masker = createMasker();
      const result = masker.mask('');
      expect(result.leadingWhitespace).toBe('');
      expect(result.trailingWhitespace).toBe('');
    });

    it('should trim after case normalization', () => {
      const masker = createMasker();
      const result = masker.mask(' HELLO WORLD ');
      expect(result.masked).toBe('hello world');
      expect(result.casePattern).toBe('upper');
      expect(result.leadingWhitespace).toBe(' ');
      expect(result.trailingWhitespace).toBe(' ');
    });
  });

  describe('case normalization roundtrip', () => {
    it('should roundtrip uppercase text through mask → unmask → applyCasePattern', () => {
      const masker = createMasker();
      const original = 'CLICK <a href="/login">HERE</a> TO LOGIN';
      const { masked, variables, tagAttributes, casePattern } = masker.mask(original);

      expect(casePattern).toBe('upper');
      expect(masked).toBe('click <a0>here</a0> to login');

      // Simulate a translation of the lowercase key
      const translated = 'cliquez <a0>ici</a0> pour se connecter';
      const unmasked = masker.unmask(translated, variables, tagAttributes);
      const final = masker.applyCasePattern(unmasked, casePattern);

      expect(final).toBe('CLIQUEZ <a href="/login">ICI</a> POUR SE CONNECTER');
    });

    it('should roundtrip lowercase text unchanged', () => {
      const masker = createMasker();
      const original = 'click here to login';
      const { variables, tagAttributes, casePattern } = masker.mask(original);

      expect(casePattern).toBe('lower');

      const translated = 'cliquez ici pour se connecter';
      const unmasked = masker.unmask(translated, variables, tagAttributes);
      const final = masker.applyCasePattern(unmasked, casePattern);

      expect(final).toBe('cliquez ici pour se connecter');
    });
  });

  describe('runtime ignoreWords mutation', () => {
    describe('getIgnoreWords()', () => {
      it('should return the current ignore words', () => {
        const masker = createMasker({ ignoreWords: ['Alice', 'Bob'] });
        expect(masker.getIgnoreWords()).toEqual(expect.arrayContaining(['Alice', 'Bob']));
        expect(masker.getIgnoreWords()).toHaveLength(2);
      });

      it('should return empty array when no ignore words', () => {
        const masker = createMasker();
        expect(masker.getIgnoreWords()).toEqual([]);
      });

      it('should return a defensive copy', () => {
        const masker = createMasker({ ignoreWords: ['Alice'] });
        const words = masker.getIgnoreWords();
        words.push('Bob');
        expect(masker.getIgnoreWords()).toEqual(['Alice']);
      });

      it('should return words sorted longest-first', () => {
        const masker = createMasker({ ignoreWords: ['Al', 'Alice', 'A'] });
        expect(masker.getIgnoreWords()).toEqual(['Alice', 'Al', 'A']);
      });

      it('should preserve metadata in entries that have it', () => {
        const masker = createMasker({
          ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }, 'Bob'],
        });
        expect(masker.getIgnoreWords()).toEqual([
          { word: 'Mary', meta: { gender: 'female' } },
          'Bob',
        ]);
      });

      it('should round-trip through setIgnoreWords without losing metadata', () => {
        const masker = createMasker({
          ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }, 'Bob'],
        });
        masker.setIgnoreWords(masker.getIgnoreWords());
        const result = masker.mask('Hello Mary');
        expect(result.variables).toEqual([v('Mary', 'ignoreWord', { gender: 'female' })]);
      });
    });

    describe('addIgnoreWords()', () => {
      it('should add a word and affect masking', () => {
        const masker = createMasker({ ignoreWords: [] });
        expect(masker.mask('Hello Mary').masked).toBe('Hello Mary');

        masker.addIgnoreWords('Mary');
        expect(masker.mask('Hello Mary').masked).toBe('Hello {{0}}');
        expect(masker.mask('Hello Mary').variables).toEqual([v('Mary', 'ignoreWord')]);
      });

      it('should add multiple words at once', () => {
        const masker = createMasker();
        masker.addIgnoreWords('Alice', 'Bob');
        expect(masker.getIgnoreWords()).toContain('Alice');
        expect(masker.getIgnoreWords()).toContain('Bob');
      });

      it('should not add duplicate words', () => {
        const masker = createMasker({ ignoreWords: ['Alice'] });
        masker.addIgnoreWords('Alice');
        expect(masker.getIgnoreWords()).toEqual(['Alice']);
      });

      it('should skip empty strings', () => {
        const masker = createMasker();
        masker.addIgnoreWords('', 'Alice', '');
        expect(masker.getIgnoreWords()).toEqual(['Alice']);
      });

      it('should maintain longest-first sort after adding', () => {
        const masker = createMasker({ ignoreWords: ['Al'] });
        masker.addIgnoreWords('Alice');
        expect(masker.getIgnoreWords()).toEqual(['Alice', 'Al']);
      });

      it('should prefer longer match after adding longer word', () => {
        const masker = createMasker({ ignoreWords: ['John'] });
        masker.addIgnoreWords('John Doe');

        const result = masker.mask('Hello John Doe');
        expect(result.masked).toBe('Hello {{0}}');
        expect(result.variables).toEqual([v('John Doe', 'ignoreWord')]);
      });

      it('should handle object entries with metadata', () => {
        const masker = createMasker({ ignoreWords: [] });
        masker.addIgnoreWords({ word: 'Mary', meta: { gender: 'female' } });
        const result = masker.mask('Hello Mary');
        expect(result.masked).toBe('Hello {{0}}');
        expect(result.variables).toEqual([v('Mary', 'ignoreWord', { gender: 'female' })]);
      });

      it('should handle mixed string and object entries', () => {
        const masker = createMasker({ ignoreWords: [] });
        masker.addIgnoreWords('Alice', { word: 'Bob', meta: { gender: 'male' } });
        const aliceResult = masker.mask('Hello Alice');
        expect(aliceResult.variables).toEqual([v('Alice', 'ignoreWord')]);
        const bobResult = masker.mask('Hello Bob');
        expect(bobResult.variables).toEqual([v('Bob', 'ignoreWord', { gender: 'male' })]);
      });

      it('should deduplicate object entries by word', () => {
        const masker = createMasker({ ignoreWords: ['Alice'] });
        masker.addIgnoreWords({ word: 'Alice', meta: { gender: 'female' } });
        expect(masker.getIgnoreWords()).toEqual(['Alice']);
      });

      it('should not overwrite existing entry when adding duplicate with metadata', () => {
        const masker = createMasker({ ignoreWords: ['Mary'] });
        masker.addIgnoreWords({ word: 'Mary', meta: { gender: 'female' } });
        // Original entry has no metadata; duplicate is silently skipped
        const result = masker.mask('Hello Mary');
        expect(result.variables).toEqual([v('Mary', 'ignoreWord')]);
      });
    });

    describe('removeIgnoreWords()', () => {
      it('should remove a word and stop masking it', () => {
        const masker = createMasker({ ignoreWords: ['Mary'] });
        expect(masker.mask('Hello Mary').masked).toBe('Hello {{0}}');

        masker.removeIgnoreWords('Mary');
        expect(masker.mask('Hello Mary').masked).toBe('Hello Mary');
      });

      it('should remove multiple words at once', () => {
        const masker = createMasker({ ignoreWords: ['Alice', 'Bob'] });
        masker.removeIgnoreWords('Alice', 'Bob');
        expect(masker.getIgnoreWords()).toEqual([]);
      });

      it('should silently ignore words not in the list', () => {
        const masker = createMasker({ ignoreWords: ['Alice'] });
        masker.removeIgnoreWords('NotInList');
        expect(masker.getIgnoreWords()).toEqual(['Alice']);
      });

      it('should preserve sort order after removal', () => {
        const masker = createMasker({ ignoreWords: ['Alice', 'Al', 'A'] });
        masker.removeIgnoreWords('Al');
        expect(masker.getIgnoreWords()).toEqual(['Alice', 'A']);
      });

      it('should handle object entries for removal', () => {
        const masker = createMasker({
          ignoreWords: [{ word: 'Mary', meta: { gender: 'female' } }],
        });
        expect(masker.mask('Hello Mary').masked).toBe('Hello {{0}}');
        masker.removeIgnoreWords({ word: 'Mary', meta: { gender: 'female' } });
        expect(masker.mask('Hello Mary').masked).toBe('Hello Mary');
      });

      it('should handle mixed string and object entries for removal', () => {
        const masker = createMasker({
          ignoreWords: ['Alice', { word: 'Bob', meta: { gender: 'male' } }],
        });
        masker.removeIgnoreWords('Alice', { word: 'Bob' });
        expect(masker.getIgnoreWords()).toEqual([]);
      });
    });

    describe('setIgnoreWords()', () => {
      it('should replace the entire list', () => {
        const masker = createMasker({ ignoreWords: ['Alice'] });
        masker.setIgnoreWords(['Bob', 'Charlie']);
        expect(masker.getIgnoreWords()).toEqual(['Charlie', 'Bob']);
      });

      it('should affect masking after replacement', () => {
        const masker = createMasker({ ignoreWords: ['Alice'] });
        masker.setIgnoreWords(['Bob']);

        expect(masker.mask('Hello Alice').masked).toBe('Hello Alice');
        expect(masker.mask('Hello Bob').masked).toBe('Hello {{0}}');
      });

      it('should handle setting to empty array', () => {
        const masker = createMasker({ ignoreWords: ['Alice'] });
        masker.setIgnoreWords([]);
        expect(masker.getIgnoreWords()).toEqual([]);
        expect(masker.mask('Hello Alice').masked).toBe('Hello Alice');
      });

      it('should handle object entries with metadata', () => {
        const masker = createMasker({ ignoreWords: ['Alice'] });
        masker.setIgnoreWords([{ word: 'Mary', meta: { gender: 'female' } }]);
        const result = masker.mask('Hello Mary');
        expect(result.masked).toBe('Hello {{0}}');
        expect(result.variables).toEqual([v('Mary', 'ignoreWord', { gender: 'female' })]);
      });

      it('should handle mixed string and object entries', () => {
        const masker = createMasker();
        masker.setIgnoreWords(['Alice', { word: 'Bob', meta: { gender: 'male' } }]);
        expect(masker.getIgnoreWords()).toEqual([
          'Alice',
          { word: 'Bob', meta: { gender: 'male' } },
        ]);
        const result = masker.mask('Hello Bob');
        expect(result.variables).toEqual([v('Bob', 'ignoreWord', { gender: 'male' })]);
      });
    });
  });
});
