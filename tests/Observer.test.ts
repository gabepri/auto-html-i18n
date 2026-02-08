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

    it('should handle element with only inline children (no direct text)', () => {
      root.innerHTML = '<p><b>Bold only</b></p>';
      const { observer, onTextFound } = createObserver(root);
      observer.start();

      expect(onTextFound).toHaveBeenCalledTimes(1);
      expect(onTextFound.mock.calls[0]![1]).toBe('<b>Bold only</b>');

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
