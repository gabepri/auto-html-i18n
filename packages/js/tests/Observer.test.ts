import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Observer } from '../src/Observer';
import type { ObserverConfig } from '../src/types';

const ALLOWED_INLINE_TAGS = ['a', 'b', 'i', 'u', 'strong', 'em', 'span', 'small', 'mark', 'del'];

function createObserver(
  root: HTMLElement,
  overrides: Partial<ObserverConfig> = {}
): { observer: Observer; onTextFound: ReturnType<typeof vi.fn>; onAttributeFound: ReturnType<typeof vi.fn> } {
  const onTextFound = vi.fn();
  const onAttributeFound = vi.fn();
  const config: ObserverConfig = {
    rootElement: root,
    allowedInlineTags: ALLOWED_INLINE_TAGS,
    ignoreSelectors: ['script', 'style', 'code'],
    translatableAttributes: ['title', 'placeholder', 'alt', 'aria-label'],
    originalAttribute: 'data-i18n-original',
    pendingAttribute: 'data-i18n-pending',
    keyAttribute: 'data-i18n-key',
    ignoreAttribute: 'data-i18n-ignore',
    onTextFound,
    onAttributeFound,
    ...overrides,
  };
  const observer = new Observer(config);
  return { observer, onTextFound, onAttributeFound };
}

// Helper to wait for MutationObserver callbacks to fire
async function waitForMutations(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Observer', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  describe('start() - initial scan', () => {
    it('should find text nodes in the root element', () => {
      root.innerHTML = '<p>Hello World</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(text).toBe('Hello World');
      expect(element.tagName).toBe('P');

      observer.stop();
    });

    it('should find text in multiple elements', () => {
      root.innerHTML = '<p>Hello</p><p>World</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(2);
      observer.stop();
    });

    it('should find translatable attributes', () => {
      root.innerHTML = '<input placeholder="Enter name" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();

      expect(onAttributeFound).toHaveBeenCalledTimes(1);
      const [, attr, value] = onAttributeFound.mock.calls[0]!;
      expect(attr).toBe('placeholder');
      expect(value).toBe('Enter name');

      observer.stop();
    });

    it('should find multiple translatable attributes', () => {
      root.innerHTML = '<img alt="Photo" title="My Photo" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();

      expect(onAttributeFound).toHaveBeenCalledTimes(2);
      observer.stop();
    });

    it('should skip ignored selectors', () => {
      root.innerHTML = '<script>var x = 1;</script><p>Text</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Text');

      observer.stop();
    });

    it('should skip style elements', () => {
      root.innerHTML = '<style>.foo { color: red; }</style><p>Text</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Text');

      observer.stop();
    });

    it('should skip code elements', () => {
      root.innerHTML = '<code>const x = 1;</code><p>Text</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Text');

      observer.stop();
    });

    it('should forward already-translated nodes (the translator decides what to skip)', () => {
      root.innerHTML = '<p data-i18n-original="Hello">Hola</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Hola');

      observer.stop();
    });

    it('should skip whitespace-only text nodes', () => {
      root.innerHTML = '<div>   \n\t  </div><p>Text</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Text');

      observer.stop();
    });

    it('should aggregate inline tags as part of parent text', () => {
      root.innerHTML = '<p>Click <a href="/login">here</a> to continue</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      // Should report the full innerHTML of <p>, not individual text nodes
      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('P');
      expect(text).toBe('Click <a href="/login">here</a> to continue');

      observer.stop();
    });

    it('should aggregate multiple inline tags', () => {
      root.innerHTML = '<p>Hello <b>bold</b> and <i>italic</i> text</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Hello <b>bold</b> and <i>italic</i> text');

      observer.stop();
    });

    it('should not aggregate non-inline tags', () => {
      root.innerHTML = '<div><p>First</p><p>Second</p></div>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(2);

      observer.stop();
    });

    it('should not aggregate when parent has mix of inline and non-inline children', () => {
      root.innerHTML = '<button><div class="spinner"><svg><path d="M12 22"></path></svg></div><span class="label">Next</span></button>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      // Should report just "Next" from the span, not the entire button innerHTML with SVG
      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('SPAN');
      expect(text).toBe('Next');

      observer.stop();
    });

    it('should not aggregate when a deep descendant (not a direct child) is non-inline', () => {
      // FormKit checkbox option: the wrapper's direct children are both <span>
      // (inline-allowed), but one span contains an <input>/<svg> subtree.
      root.innerHTML =
        '<label class="fk-wrapper"><span class="fk-inner">' +
        '<input type="checkbox" value="Environmental">' +
        '<span class="fk-decorator"><span class="fk-icon"><svg viewBox="0 0 24 24"><path d="m10 14"></path></svg></span></span>' +
        '</span><span class="fk-label">Environmental</span></label>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      // Should report just the clean "Environmental" label, never the svg/input blob.
      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('SPAN');
      expect(text).toBe('Environmental');

      observer.stop();
    });

    it('should still aggregate when all descendants are inline-allowed', () => {
      root.innerHTML = '<p>Hello <b><i>bold italic</i></b> world</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Hello <b><i>bold italic</i></b> world');

      observer.stop();
    });

    it('reports only the outermost of nested aggregation targets', () => {
      // Both the <p> (direct text "Unit:" + inline <span>) and the nested <span>
      // (direct text "value" + inline <b>) independently qualify as aggregation
      // targets. The span's content already rides inside the <p>'s unit, so it must
      // not be reported a second time on its own — only the outermost target of a
      // nested chain should be aggregated. (Currently the inner span is reported too.)
      root.innerHTML = '<p>Unit: <span>value <b>x</b></span></p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('P');
      expect(text).toBe('Unit: <span>value <b>x</b></span>');

      observer.stop();
    });
  });

  /**
   * The texts reported for one element. Reported directly rather than via
   * toHaveBeenCalledWith, which also compares arity — the walk passes an explicit
   * `undefined` third argument where the mutation path passes only two.
   */
  function textsFor(onTextFound: ReturnType<typeof vi.fn>, element: Element): string[] {
    return onTextFound.mock.calls
      .filter((call: unknown[]) => call[0] === element)
      .map((call: unknown[]) => call[1] as string);
  }

  describe('aggregation targets across mutation batches', () => {
    // processedParents dedupes aggregation targets *within one collection batch*: a
    // sentence with several text nodes must be reported once, not once per node. It is
    // scoped to that batch and nothing longer — an element the initial scan aggregated
    // has to be reportable again when its content later changes.
    it('re-aggregates a parent the initial scan already reported', async () => {
      root.innerHTML = '<p>Hello <strong>there</strong></p>';
      const { observer, onTextFound } = createObserver(root);
      const para = root.querySelector('p')!;

      observer.start();
      // The initial scan aggregates the paragraph into one unit.
      expect(textsFor(onTextFound, para)).toEqual(['Hello <strong>there</strong>']);
      onTextFound.mockClear();

      // A framework appends a bare text node into that same paragraph. A processedParents
      // entry left over from the initial scan would swallow this entirely.
      para.appendChild(document.createTextNode(' friend'));
      await waitForMutations();

      expect(textsFor(onTextFound, para)).toEqual(['Hello <strong>there</strong> friend']);

      observer.stop();
    });

    it('reports an aggregation target once when several of its text nodes change together', async () => {
      root.innerHTML = '<p>Hello <strong>there</strong></p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();
      onTextFound.mockClear();

      // Two text nodes land in the same paragraph in one batch — one aggregated unit.
      const para = root.querySelector('p')!;
      para.appendChild(document.createTextNode(' friend'));
      para.appendChild(document.createTextNode(' indeed'));
      await waitForMutations();

      expect(textsFor(onTextFound, para)).toHaveLength(1);

      observer.stop();
    });

    it('reports a shared aggregation ancestor once when several elements land in one batch', async () => {
      root.innerHTML = '<p>Hello <strong>there</strong></p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();
      onTextFound.mockClear();

      // Two inline elements added to the same paragraph in one batch. Both climb to the
      // same aggregation target, which must still be reported once — resetting the dedupe
      // set per added element loses that.
      const para = root.querySelector('p')!;
      const em = document.createElement('em');
      em.textContent = 'really';
      const b = document.createElement('b');
      b.textContent = 'truly';
      para.append(em, b);
      await waitForMutations();

      expect(textsFor(onTextFound, para)).toHaveLength(1);

      observer.stop();
    });
  });

  describe('mutation observation', () => {
    it('should detect new text nodes added to DOM', async () => {
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      const p = document.createElement('p');
      p.textContent = 'New text';
      root.appendChild(p);
      await waitForMutations();

      // Leaf text units carry the specific Text node they live in — a parent can hold
      // several, and each is its own unit.
      expect(onTextFound).toHaveBeenCalledWith(p, 'New text', p.firstChild);

      observer.stop();
    });

    it('should detect text content changes (characterData)', async () => {
      root.innerHTML = '<p>Original</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();
      onTextFound.mockClear();

      const p = root.querySelector('p')!;
      p.textContent = 'Changed';
      await waitForMutations();

      expect(onTextFound).toHaveBeenCalled();
      // Find the call with 'Changed' text
      const changedCall = onTextFound.mock.calls.find(
        (call: unknown[]) => call[1] === 'Changed'
      );
      expect(changedCall).toBeDefined();

      observer.stop();
    });

    it('should detect new elements with inline tags', async () => {
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      const p = document.createElement('p');
      p.innerHTML = 'Click <a href="/test">here</a>';
      root.appendChild(p);
      await waitForMutations();

      const inlineCall = onTextFound.mock.calls.find(
        (call: unknown[]) => (call[1] as string).includes('<a')
      );
      expect(inlineCall).toBeDefined();

      observer.stop();
    });

    it('should not trigger for changes inside ignored selectors', async () => {
      root.innerHTML = '<code></code>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();
      onTextFound.mockClear();

      const code = root.querySelector('code')!;
      code.textContent = 'var x = 1;';
      await waitForMutations();

      expect(onTextFound).not.toHaveBeenCalled();

      observer.stop();
    });
  });

  describe('stop()', () => {
    it('should stop observing mutations after disconnect', async () => {
      const { observer, onTextFound } = createObserver(root);
      observer.start();
      observer.stop();
      onTextFound.mockClear();

      const p = document.createElement('p');
      p.textContent = 'After stop';
      root.appendChild(p);
      await waitForMutations();

      expect(onTextFound).not.toHaveBeenCalled();
    });
  });

  describe('reprocessAll()', () => {
    it('should re-report nodes with originalAttribute', () => {
      root.innerHTML = '<p data-i18n-original="Hello">Hola</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();
      onTextFound.mockClear();

      observer.reprocessAll();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('P');
      expect(text).toBe('Hello');

      observer.stop();
    });

    it('should re-report multiple translated nodes', () => {
      root.innerHTML = '<p data-i18n-original="Hello">Hola</p><p data-i18n-original="Bye">Adiós</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();
      onTextFound.mockClear();

      observer.reprocessAll();

      expect(onTextFound).toHaveBeenCalledTimes(2);

      observer.stop();
    });
  });

  describe('ignoreAttribute', () => {
    it('should skip elements with the ignore attribute during initial scan', () => {
      root.innerHTML = '<div data-i18n-ignore><p>Ignored text</p></div><p>Visible text</p>';
      const { observer, onTextFound, onAttributeFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Visible text');
      expect(onAttributeFound).not.toHaveBeenCalled();

      observer.stop();
    });

    it('should skip attributes on elements inside ignored subtree', () => {
      root.innerHTML = '<div data-i18n-ignore><input placeholder="Ignored" /></div><input placeholder="Visible" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();

      expect(onAttributeFound).toHaveBeenCalledTimes(1);
      expect(onAttributeFound.mock.calls[0]![2]).toBe('Visible');

      observer.stop();
    });

    it('should skip deeply nested children under ignored element', () => {
      root.innerHTML = '<div data-i18n-ignore><section><article><p>Deep ignored</p></article></section></div><p>Visible</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Visible');

      observer.stop();
    });

    it('should not report mutations inside ignored element', async () => {
      root.innerHTML = '<div data-i18n-ignore></div>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();
      onTextFound.mockClear();

      const ignored = root.querySelector('[data-i18n-ignore]')!;
      const p = document.createElement('p');
      p.textContent = 'Dynamic ignored text';
      ignored.appendChild(p);
      await waitForMutations();

      expect(onTextFound).not.toHaveBeenCalled();

      observer.stop();
    });

    it('should still process siblings of ignored elements', () => {
      root.innerHTML = '<p>Before</p><div data-i18n-ignore><p>Ignored</p></div><p>After</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(2);
      const texts = onTextFound.mock.calls.map((call: unknown[]) => call[1]);
      expect(texts).toContain('Before');
      expect(texts).toContain('After');

      observer.stop();
    });
  });

  describe('attribute forwarding (translator decides what to skip)', () => {
    it('should forward attributes with original-tracking data attribute during initial scan', () => {
      root.innerHTML = '<input placeholder="Ingrese nombre" data-i18n-original-placeholder="Enter name" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();

      expect(onAttributeFound).toHaveBeenCalledTimes(1);
      expect(onAttributeFound.mock.calls[0]![1]).toBe('placeholder');
      expect(onAttributeFound.mock.calls[0]![2]).toBe('Ingrese nombre');

      observer.stop();
    });

    it('should forward attribute mutations when original-tracking attribute exists', async () => {
      root.innerHTML = '<input placeholder="Enter name" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();
      onAttributeFound.mockClear();

      const input = root.querySelector('input')!;
      input.setAttribute('data-i18n-original-placeholder', 'Enter name');
      input.setAttribute('placeholder', 'Ingrese nombre');
      await waitForMutations();

      expect(onAttributeFound).toHaveBeenCalledTimes(1);
      expect(onAttributeFound.mock.calls[0]![2]).toBe('Ingrese nombre');

      observer.stop();
    });

    it('should still process attributes without original-tracking attribute', () => {
      root.innerHTML = '<input placeholder="Enter name" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();

      expect(onAttributeFound).toHaveBeenCalledTimes(1);
      expect(onAttributeFound.mock.calls[0]![2]).toBe('Enter name');

      observer.stop();
    });

    it('should report every translatable attribute on the same element', () => {
      root.innerHTML = '<img alt="Photo" title="My Photo" data-i18n-original-alt="Photo" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();

      // Both attributes are forwarded; the translator skips ones it already handled
      expect(onAttributeFound).toHaveBeenCalledTimes(2);
      const attrs = onAttributeFound.mock.calls.map((call: unknown[]) => call[1]);
      expect(attrs).toContain('title');
      expect(attrs).toContain('alt');

      observer.stop();
    });

    it('should forward already-translated attributes during subtree mutation processing', async () => {
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();
      onAttributeFound.mockClear();

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Ingrese nombre');
      input.setAttribute('data-i18n-original-placeholder', 'Enter name');
      root.appendChild(input);
      await waitForMutations();

      expect(onAttributeFound).toHaveBeenCalledTimes(1);
      expect(onAttributeFound.mock.calls[0]![2]).toBe('Ingrese nombre');

      observer.stop();
    });
  });

  describe('mutation processing resilience to inline DOM mutations', () => {
    it('should process all sibling text nodes even when onTextFound mutates the DOM', async () => {
      const { observer, onTextFound } = createObserver(root);

      // Simulate what happens when a synchronous cache hit causes applyTranslation
      // to mutate the DOM during TreeWalker traversal. The echo guard mirrors the
      // translator, which ignores content it already translated.
      onTextFound.mockImplementation((element: Element, text: string) => {
        if (element.hasAttribute('data-i18n-original')) return;
        element.textContent = 'translated';
        element.setAttribute('data-i18n-original', text);
      });

      observer.start();

      // Add a nav with 3 sibling items (like Vue 3 rendering a list)
      const nav = document.createElement('nav');
      nav.innerHTML = '<li><span>Privacy Policy</span></li><li><span>Terms of Service</span></li><li><span>Help &amp; FAQs</span></li>';
      root.appendChild(nav);
      await waitForMutations();

      // All 3 text nodes should have been found, not just the first one
      const texts = onTextFound.mock.calls.map((call: unknown[]) => call[1]);
      expect(texts).toContain('Privacy Policy');
      expect(texts).toContain('Terms of Service');
      expect(texts).toContain('Help & FAQs');

      observer.stop();
    });

    it('should process all elements in a mutation batch when early callbacks mutate DOM', async () => {
      const { observer, onTextFound } = createObserver(root);
      const found: string[] = [];

      onTextFound.mockImplementation((_element: Element, text: string) => {
        if (_element.hasAttribute('data-i18n-original')) return;
        found.push(text);
        // Mutate the element (simulates synchronous translation from cache)
        _element.textContent = `[translated] ${text}`;
        _element.setAttribute('data-i18n-original', text);
      });

      observer.start();

      const container = document.createElement('div');
      container.innerHTML = '<p>First</p><p>Second</p><p>Third</p>';
      root.appendChild(container);
      await waitForMutations();

      expect(found).toContain('First');
      expect(found).toContain('Second');
      expect(found).toContain('Third');

      observer.stop();
    });
  });

  describe('edge cases', () => {
    it('should handle nested ignored selectors', () => {
      root.innerHTML = '<code><span>should be ignored</span></code><p>Text</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Text');

      observer.stop();
    });

    it('should handle deeply nested text', () => {
      root.innerHTML = '<div><section><article><p>Deep text</p></article></section></div>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('Deep text');

      observer.stop();
    });

    it('should not aggregate when single inline child wraps all content', () => {
      root.innerHTML = '<p><b>Bold only</b></p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('B');
      expect(text).toBe('Bold only');

      observer.stop();
    });

    it('should not aggregate single wrapper with attributes', () => {
      root.innerHTML = '<div><a href="/login" class="link">Click</a></div>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('A');
      expect(text).toBe('Click');

      observer.stop();
    });

    it('should not aggregate nested single wrappers', () => {
      root.innerHTML = '<div><a><b>Bold link</b></a></div>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('B');
      expect(text).toBe('Bold link');

      observer.stop();
    });

    it('should not aggregate multiple inline children without direct text', () => {
      // A container whose children are all inline elements but which has no
      // direct text of its own is structural (a menu / link list), not a
      // formatted sentence: translate each child individually so its DOM node
      // (and any framework listeners) survives.
      root.innerHTML = '<p><b>Hello</b><i>World</i></p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(2);
      const [firstEl, firstText] = onTextFound.mock.calls[0]!;
      const [secondEl, secondText] = onTextFound.mock.calls[1]!;
      expect(firstEl.tagName).toBe('B');
      expect(firstText).toBe('Hello');
      expect(secondEl.tagName).toBe('I');
      expect(secondText).toBe('World');

      observer.stop();
    });

    it('should not aggregate a pure link-list container (nav menu)', () => {
      // The reported bug: a dropdown whose only children are router-link <a>s.
      // Aggregating + innerHTML apply would recreate the anchors and drop their
      // framework click listeners. Each anchor must be its own unit.
      root.innerHTML = '<nav><a href="/a">Plan</a><a href="/b">Earnings</a></nav>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(2);
      const [firstEl, firstText] = onTextFound.mock.calls[0]!;
      const [secondEl, secondText] = onTextFound.mock.calls[1]!;
      expect(firstEl.tagName).toBe('A');
      expect(firstText).toBe('Plan');
      expect(secondEl.tagName).toBe('A');
      expect(secondText).toBe('Earnings');

      observer.stop();
    });

    it('should not aggregate a link list separated by whitespace only', () => {
      root.innerHTML = '<nav> <a href="/a">Home</a> <a href="/b">About</a> </nav>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(2);
      expect(onTextFound.mock.calls[0]![0].tagName).toBe('A');
      expect(onTextFound.mock.calls[0]![1]).toBe('Home');
      expect(onTextFound.mock.calls[1]![0].tagName).toBe('A');
      expect(onTextFound.mock.calls[1]![1]).toBe('About');

      observer.stop();
    });

    it('should not aggregate links whose labels are wrapped in inline elements', () => {
      root.innerHTML =
        '<nav><a href="/a"><span>Home</span></a><a href="/b"><span>About</span></a></nav>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(2);
      expect(onTextFound.mock.calls[0]![0].tagName).toBe('SPAN');
      expect(onTextFound.mock.calls[0]![1]).toBe('Home');
      expect(onTextFound.mock.calls[1]![0].tagName).toBe('SPAN');
      expect(onTextFound.mock.calls[1]![1]).toBe('About');

      observer.stop();
    });

    it('should still aggregate a container with visible separator text between links', () => {
      // Direct text " / " exists, so this is a formatted run and stays one unit.
      // (Preserving the anchors here is Layer 2's job, not the aggregation gate's.)
      root.innerHTML = '<nav><a href="/">Home</a> / <a href="/p">Products</a></nav>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('NAV');
      expect(text).toBe('<a href="/">Home</a> / <a href="/p">Products</a>');

      observer.stop();
    });

    it('should still aggregate single inline child with sibling text', () => {
      root.innerHTML = '<p>text <a href="/link">link</a></p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('P');
      expect(text).toBe('text <a href="/link">link</a>');

      observer.stop();
    });

    it('should handle data-i18n-key attribute', () => {
      root.innerHTML = '<span data-i18n-key="custom.key">Some text</span>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      // The observer reports the text as-is; the Translator handles keyAttribute
      expect(onTextFound.mock.calls[0]![1]).toBe('Some text');

      observer.stop();
    });
  });

  describe('ignore-check cost', () => {
    // The TreeWalker rejects an ignored element's whole subtree, so every node it
    // hands us already has an accepted ancestry. Re-walking that ancestry per node —
    // running every ignoreSelector against every ancestor — is redundant work that
    // scales with tree depth. Budget assertion, not a timing one: it stays honest on
    // a loaded CI box and catches the regression the moment it's reintroduced.
    function buildDeepTree(root: HTMLElement, rows: number, depth: number): void {
      let html = '';
      for (let r = 0; r < rows; r++) {
        let inner = `<p>Row ${r} of the list</p>`;
        for (let d = 0; d < depth; d++) inner = `<div class="l${d}">${inner}</div>`;
        html += inner;
      }
      root.innerHTML = html;
    }

    it('runs each ignoreSelector at most once per element during a walk', () => {
      const rows = 30;
      const depth = 8;
      buildDeepTree(root, rows, depth);

      const selectors = ['.no-i18n', '[data-skip]', 'code', 'script', 'style'];
      const { observer } = createObserver(root, { ignoreSelectors: selectors });

      const elementCount = root.querySelectorAll('*').length + 1; // + the walk root
      const matchesSpy = vi.spyOn(Element.prototype, 'matches');

      observer.processSubtree(root);
      const calls = matchesSpy.mock.calls.length;
      matchesSpy.mockRestore();

      // Checking each element once bounds this at elements × selectors. Walking every
      // node's ancestry instead multiplies that by the tree depth (and drags text nodes
      // in too) — for this tree, ~11x more work.
      expect(calls).toBeLessThanOrEqual(elementCount * selectors.length);
    });

    it('still skips a deeply nested node inside an ignored subtree', () => {
      root.innerHTML =
        '<div><div data-i18n-ignore><div><div><p>Hidden text</p></div></div></div><p>Visible text</p></div>';

      const { observer, onTextFound } = createObserver(root);
      observer.processSubtree(root);

      const texts = onTextFound.mock.calls.map((c) => c[1]);
      expect(texts).toContain('Visible text');
      expect(texts).not.toContain('Hidden text');
    });

    it('skips the whole walk when the walk root is itself inside an ignored subtree', () => {
      root.innerHTML = '<div data-i18n-ignore><section><p>Hidden text</p></section></div>';
      const section = root.querySelector('section')!;

      const { observer, onTextFound } = createObserver(root);
      observer.processSubtree(section);

      expect(onTextFound).not.toHaveBeenCalled();
    });
  });

  describe('aggregation-check cost', () => {
    // findAggregationTarget runs per text node and climbs to the root, and each rung
    // re-tests every child's whole subtree for inline-ness. A paragraph with several
    // direct text nodes therefore rescans the same subtrees once per text node, and
    // again at every ancestor. The answers can't change mid-walk (callbacks fire only
    // after collection), so each element's verdict should be computed once.
    it('computes each element’s inline-ness at most once per walk', () => {
      const rows = 20;
      let html = '';
      for (let r = 0; r < rows; r++) {
        // Several direct text nodes interleaved with nested inline elements — each text
        // node re-enters findAggregationTarget for the same paragraph.
        html += `<section><p>Start ${r} <span>middle <em>deep</em></span> then <span>more</span> end</p></section>`;
      }
      root.innerHTML = html;

      const { observer } = createObserver(root);
      const elementCount = root.querySelectorAll('*').length;

      const inlineSpy = vi.spyOn(
        observer as unknown as { computeFullyInline: (el: Element) => boolean },
        'computeFullyInline'
      );
      const aggSpy = vi.spyOn(
        observer as unknown as { computeHasInlineChildElements: (el: Element) => boolean },
        'computeHasInlineChildElements'
      );

      observer.processSubtree(root);

      expect(inlineSpy.mock.calls.length).toBeLessThanOrEqual(elementCount);
      expect(aggSpy.mock.calls.length).toBeLessThanOrEqual(elementCount);
    });

    it('still aggregates a formatted sentence and skips a structural container', () => {
      root.innerHTML =
        '<p>Hello <strong>there</strong> friend</p>' +
        '<nav><a href="/a">One</a><a href="/b">Two</a></nav>';

      const { observer, onTextFound } = createObserver(root);
      observer.processSubtree(root);

      const texts = onTextFound.mock.calls.map((c) => c[1]);
      // The sentence aggregates into one unit...
      expect(texts).toContain('Hello <strong>there</strong> friend');
      // ...while the nav's links stay independent.
      expect(texts).toContain('One');
      expect(texts).toContain('Two');
    });

    it('re-reads inline-ness on a later walk after the DOM changed', () => {
      root.innerHTML = '<p>Hello <strong>there</strong> friend</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.processSubtree(root);
      expect(onTextFound.mock.calls.map((c) => c[1])).toContain('Hello <strong>there</strong> friend');

      // An <input> makes the paragraph no longer fully inline — a memo held across
      // walks would still call it aggregatable.
      onTextFound.mockClear();
      root.querySelector('strong')!.appendChild(document.createElement('input'));
      observer.processSubtree(root);

      const texts = onTextFound.mock.calls.map((c) => c[1]);
      expect(texts).not.toContain('Hello <strong>there</strong> friend');
    });
  });
});
