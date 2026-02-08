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
      const [element, attr, value] = onAttributeFound.mock.calls[0]!;
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

    it('should skip already-translated nodes (has originalAttribute)', () => {
      root.innerHTML = '<p data-i18n-original="Hello">Hola</p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).not.toHaveBeenCalled();

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
  });

  describe('mutation observation', () => {
    it('should detect new text nodes added to DOM', async () => {
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      const p = document.createElement('p');
      p.textContent = 'New text';
      root.appendChild(p);
      await waitForMutations();

      expect(onTextFound).toHaveBeenCalledWith(p, 'New text');

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
      expect(onTextFound).not.toHaveBeenCalled();

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

  describe('attribute re-translation prevention', () => {
    it('should skip attributes with original-tracking data attribute during initial scan', () => {
      root.innerHTML = '<input placeholder="Ingrese nombre" data-i18n-original-placeholder="Enter name" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();

      expect(onAttributeFound).not.toHaveBeenCalled();

      observer.stop();
    });

    it('should skip attribute mutations when original-tracking attribute exists', async () => {
      root.innerHTML = '<input placeholder="Enter name" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();
      onAttributeFound.mockClear();

      const input = root.querySelector('input')!;
      input.setAttribute('data-i18n-original-placeholder', 'Enter name');
      input.setAttribute('placeholder', 'Ingrese nombre');
      await waitForMutations();

      expect(onAttributeFound).not.toHaveBeenCalled();

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

    it('should handle multiple attributes independently on the same element', () => {
      root.innerHTML = '<img alt="Photo" title="My Photo" data-i18n-original-alt="Photo" />';
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();

      // alt should be skipped (has original-tracking), title should be reported
      expect(onAttributeFound).toHaveBeenCalledTimes(1);
      expect(onAttributeFound.mock.calls[0]![1]).toBe('title');
      expect(onAttributeFound.mock.calls[0]![2]).toBe('My Photo');

      observer.stop();
    });

    it('should skip already-translated attributes during subtree mutation processing', async () => {
      const { observer, onAttributeFound } = createObserver(root);
      observer.start();
      onAttributeFound.mockClear();

      const input = document.createElement('input');
      input.setAttribute('placeholder', 'Ingrese nombre');
      input.setAttribute('data-i18n-original-placeholder', 'Enter name');
      root.appendChild(input);
      await waitForMutations();

      expect(onAttributeFound).not.toHaveBeenCalled();

      observer.stop();
    });
  });

  describe('mutation processing resilience to inline DOM mutations', () => {
    it('should process all sibling text nodes even when onTextFound mutates the DOM', async () => {
      const { observer, onTextFound } = createObserver(root);

      // Simulate what happens when a synchronous cache hit causes applyTranslation
      // to mutate the DOM during TreeWalker traversal
      onTextFound.mockImplementation((element: Element) => {
        // This simulates Translator.applyTranslation setting textContent + data-i18n-original
        element.textContent = 'translated';
        element.setAttribute('data-i18n-original', element.textContent);
      });

      observer.start();

      // Add a nav with 3 sibling items (like Vue 3 rendering a list)
      const nav = document.createElement('nav');
      nav.innerHTML = '<li><span>Privacy Policy</span></li><li><span>Terms of Service</span></li><li><span>Help &amp; FAQs</span></li>';
      root.appendChild(nav);
      await waitForMutations();

      // All 3 text nodes should have been found, not just the first one
      expect(onTextFound).toHaveBeenCalledTimes(3);
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

    it('should still aggregate multiple inline children without direct text', () => {
      root.innerHTML = '<p><b>Hello</b><i>World</i></p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      const [element, text] = onTextFound.mock.calls[0]!;
      expect(element.tagName).toBe('P');
      expect(text).toBe('<b>Hello</b><i>World</i>');

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
});
