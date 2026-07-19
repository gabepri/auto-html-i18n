import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { I18nObserver } from '../src/I18nObserver';
import type { I18nConfig, TranslationItem } from '../src/types';

/**
 * Graduated coexistence with external/browser page translation
 * (`externalTranslation` config option).
 *
 * These tests simulate the DOM footprints of Chrome translate (root classes),
 * Edge translate (proprietary attributes) and Immersive Translate (injected
 * bilingual nodes). This environment can't run the real translation engines, so
 * release verification additionally needs a manual pass in real Chrome/Edge.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// One MutationObserver delivery plus several full debounce windows (30ms here).
const flush = () => sleep(120);

describe('externalTranslation', () => {
  let root: HTMLElement;
  let observers: I18nObserver[];

  function createI18n(overrides: Partial<I18nConfig> = {}) {
    const onMissing = vi.fn().mockResolvedValue(null);
    const i18n = new I18nObserver({
      locale: 'es',
      onMissingTranslation: onMissing,
      rootElement: root,
      debounceTime: 30,
      ...overrides,
    });
    observers.push(i18n);
    return { i18n, onMissing };
  }

  /** Every masked key reported across all onMissingTranslation calls so far. */
  function reportedKeys(onMissing: Mock): string[] {
    return onMissing.mock.calls.flatMap((call) =>
      (call[0] as TranslationItem[]).map((item) => item.masked)
    );
  }

  beforeEach(() => {
    observers = [];
    root = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(root);
  });

  afterEach(() => {
    for (const i18n of observers) i18n.stop();
    const html = document.documentElement;
    // Remove classes through the token list before dropping the attribute:
    // happy-dom's cached classList otherwise still reports the old tokens after a
    // bare removeAttribute('class'), leaking signal classes into the next test.
    html.classList.remove('translated-ltr', 'translated-rtl', 'acme-translated', 'notranslate', 'custom');
    html.removeAttribute('class');
    html.removeAttribute('translate');
    html.removeAttribute('dir');
    html.removeAttribute('lang');
    for (const meta of document.head.querySelectorAll('meta')) meta.remove();
  });

  it("'allow' does nothing: no markers, no suppression, reports fire as today", async () => {
    root.innerHTML = '<p>Hello</p>';
    const { i18n, onMissing } = createI18n({
      externalTranslation: 'allow',
      initialCache: { Hello: 'Hola' },
    });

    i18n.start();
    const p = root.querySelector('p')!;
    expect(p.textContent).toBe('Hola');
    // No element markers even on translated content
    expect(p.hasAttribute('translate')).toBe(false);
    expect(p.classList.contains('notranslate')).toBe(false);
    // No root stamping
    expect(document.documentElement.hasAttribute('translate')).toBe(false);
    expect(document.documentElement.classList.contains('notranslate')).toBe(false);
    expect(document.head.querySelector('meta[name="google"]')).toBeNull();

    // No suppression: a rewrite while translated-ltr is present still reports
    document.documentElement.classList.add('translated-ltr');
    const p2 = document.createElement('p');
    p2.textContent = '報酬を獲得する';
    root.appendChild(p2);
    await flush();

    expect(reportedKeys(onMissing)).toContain('報酬を獲得する');
    // Detection is skipped entirely at 'allow'
    expect(i18n.getExternalTranslationState()).toEqual({ active: false, signals: [] });
  });

  it("'suppress-reports': no reports while documentElement carries translated-ltr", async () => {
    root.innerHTML = '<p>Reward earned</p>';
    const { i18n, onMissing } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start();
    await flush();
    expect(reportedKeys(onMissing)).toEqual(['Reward earned']);
    onMissing.mockClear();

    document.documentElement.classList.add('translated-ltr');
    const p = root.querySelector('p')!;
    p.textContent = '報酬を獲得する'; // simulate Google's rewrite
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
    // The node's text is left untouched — the external translation owns it
    expect(p.textContent).toBe('報酬を獲得する');
  });

  it("'suppress-reports': entries queued but unflushed when translated-ltr appears are dropped, not flushed", async () => {
    root.innerHTML = '<p>Hello page</p>';
    const { i18n, onMissing } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start(); // enqueues 'Hello page', debounce pending
    document.documentElement.classList.add('translated-ltr');
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
  });

  it("'suppress-reports': reporting resumes after the external translation is reverted", async () => {
    root.innerHTML = '<p>Genuine text</p>';
    const { i18n, onMissing } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start();
    await flush();
    expect(reportedKeys(onMissing)).toEqual(['Genuine text']);

    document.documentElement.classList.add('translated-ltr');
    const p = root.querySelector('p')!;
    p.textContent = '本物のテキスト';
    await flush();
    expect(reportedKeys(onMissing)).toEqual(['Genuine text']);

    // Chrome's "Show original": class removed, original-language content restored
    document.documentElement.classList.remove('translated-ltr');
    p.textContent = 'Fresh english';
    await flush();

    expect(reportedKeys(onMissing)).toEqual(['Genuine text', 'Fresh english']);
  });

  it("'suppress-reports': cache hits still apply while translated-ltr is present", async () => {
    const { i18n } = createI18n({
      externalTranslation: 'suppress-reports',
      initialCache: { Hello: 'Hola' },
    });

    i18n.start();
    document.documentElement.classList.add('translated-ltr');
    await flush();
    expect(i18n.getExternalTranslationState().active).toBe(true);

    const p = document.createElement('p');
    p.textContent = 'Hello';
    root.appendChild(p);
    await flush();

    expect(p.textContent).toBe('Hola');
  });

  it("'suppress-reports': attribute misses are left alone and unreported while active", async () => {
    root.innerHTML = '<input placeholder="Search here">';
    const { i18n, onMissing } = createI18n({
      externalTranslation: 'suppress-reports',
      initialCache: { 'Search here': 'Buscar aquí' },
    });

    i18n.start();
    document.documentElement.classList.add('translated-ltr');
    await flush();
    onMissing.mockClear();

    const input = root.querySelector('input')!;
    input.setAttribute('placeholder', 'Buscar algo nuevo');
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
    expect(input.getAttribute('placeholder')).toBe('Buscar algo nuevo');
    expect(input.hasAttribute('data-i18n-pending')).toBe(false);
  });

  it('a flush already split into chunks stops reporting mid-flight when a translator engages', async () => {
    root.innerHTML = '<p>First string</p><p>Second string</p>';
    // First chunk's callback simulates a translator engaging while the flush is
    // in flight: the remaining chunk must be dropped, not reported.
    const onMissing = vi.fn().mockImplementation(async () => {
      document.documentElement.classList.add('translated-ltr');
      await sleep(10); // let the root observer deliver before the next chunk
      return null;
    });
    const i18n = new I18nObserver({
      locale: 'es',
      onMissingTranslation: onMissing,
      rootElement: root,
      debounceTime: 30,
      maxBatchSize: 1,
      externalTranslation: 'suppress-reports',
    });
    observers.push(i18n);

    i18n.start();
    await flush();

    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it("'suppress-reports' does NOT stamp element markers", () => {
    root.innerHTML = '<p>Hello</p>';
    const { i18n } = createI18n({
      externalTranslation: 'suppress-reports',
      initialCache: { Hello: 'Hola' },
    });

    i18n.start();
    const p = root.querySelector('p')!;
    expect(p.textContent).toBe('Hola');
    expect(p.hasAttribute('translate')).toBe(false);
    expect(p.classList.contains('notranslate')).toBe(false);
  });

  it('edge signal: a mutation introducing an element with _msttexthash suppresses reporting, and stays suppressed (sticky) after the attribute is gone', async () => {
    root.innerHTML = '<div id="host"><p>Some text</p></div>';
    const { i18n, onMissing } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start();
    await flush();
    expect(reportedKeys(onMissing)).toEqual(['Some text']);
    onMissing.mockClear();

    const host = root.querySelector('#host')!;
    host.setAttribute('_msttexthash', '26906851');
    await sleep(30);
    expect(i18n.getExternalTranslationState().signals).toContain('edge-translate');

    const p = root.querySelector('p')!;
    p.textContent = 'エッジの翻訳';
    await flush();
    expect(onMissing).not.toHaveBeenCalled();

    // Sticky: the attribute disappearing does not clear suppression
    host.removeAttribute('_msttexthash');
    await sleep(30);
    p.textContent = 'まだ抑制されている';
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
    expect(i18n.getExternalTranslationState().active).toBe(true);
  });

  it("immersive-translate signal: inserting a .immersive-translate-target-wrapper node suppresses reporting, and the injected node's text is never reported", async () => {
    root.innerHTML = '<p>Original sentence</p>';
    const { i18n, onMissing } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start();
    await flush();
    onMissing.mockClear();

    // The extension appends a target-language block below the original — here
    // nested inside a container, so descendant detection is exercised too.
    const block = document.createElement('div');
    const wrapper = document.createElement('font');
    wrapper.className = 'notranslate immersive-translate-target-wrapper';
    wrapper.textContent = '元の文';
    block.appendChild(wrapper);
    root.appendChild(block);
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
    expect(i18n.getExternalTranslationState().signals).toContain('immersive-translate');

    // Sticky: even after the injected node is removed, nothing new is reported —
    // including a second injected wrapper (the signal is already active)
    block.remove();
    const second = document.createElement('font');
    second.className = 'immersive-translate-target-wrapper';
    second.textContent = '二つ目';
    root.appendChild(second);
    const p = root.querySelector('p')!;
    p.textContent = '後で追加';
    await flush();
    expect(reportedKeys(onMissing)).not.toContain('元の文');
    expect(onMissing).not.toHaveBeenCalled();
  });

  it('consumer-supplied signal via extraTranslatorSignals activates detection', async () => {
    root.innerHTML = '<p>Before</p>';
    const { i18n, onMissing } = createI18n({
      externalTranslation: 'suppress-reports',
      extraTranslatorSignals: [{ id: 'custom', rootClasses: ['acme-translated'] }],
    });

    i18n.start();
    await flush();
    onMissing.mockClear();

    document.documentElement.classList.add('acme-translated');
    const p = root.querySelector('p')!;
    p.textContent = 'ジャンク';
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
    expect(i18n.getExternalTranslationState()).toEqual({ active: true, signals: ['custom'] });
  });

  it("'protect-translations': a translated element gains both markers; an untranslated sibling gains neither", async () => {
    root.innerHTML = '<p>Hello</p><p>No translation for this one</p>';
    const { i18n } = createI18n({
      externalTranslation: 'protect-translations',
      initialCache: { Hello: 'Hola' },
    });

    i18n.start();
    const [translated, untranslated] = root.querySelectorAll('p');
    expect(translated!.textContent).toBe('Hola');
    expect(translated!.getAttribute('translate')).toBe('no');
    expect(translated!.classList.contains('notranslate')).toBe(true);

    expect(untranslated!.hasAttribute('translate')).toBe(false);
    expect(untranslated!.classList.contains('notranslate')).toBe(false);

    // Re-applying (locale switch) does not double-stamp or lose the markers
    i18n.setCache('fr', { Hello: 'Bonjour' });
    i18n.setLocale('fr');
    expect(translated!.textContent).toBe('Bonjour');
    expect(translated!.getAttribute('translate')).toBe('no');
    expect(translated!.className).toBe('notranslate');
  });

  it("'protect-translations' marks elements whose attributes we translate", () => {
    root.innerHTML = '<input placeholder="Search here">';
    const { i18n } = createI18n({
      externalTranslation: 'protect-translations',
      initialCache: { 'Search here': 'Buscar aquí' },
    });

    i18n.start();
    const input = root.querySelector('input')!;
    expect(input.getAttribute('placeholder')).toBe('Buscar aquí');
    expect(input.getAttribute('translate')).toBe('no');
    expect(input.classList.contains('notranslate')).toBe(true);
  });

  it("'protect-translations' is the default when the option is omitted", () => {
    root.innerHTML = '<p>Hello</p>';
    const { i18n } = createI18n({ initialCache: { Hello: 'Hola' } });

    i18n.start();
    const p = root.querySelector('p')!;
    expect(p.textContent).toBe('Hola');
    expect(p.getAttribute('translate')).toBe('no');
    expect(p.classList.contains('notranslate')).toBe(true);
  });

  it("'protect-translations': marker stamping does not echo into collection or reporting", async () => {
    root.innerHTML = '<p>Hello</p>';
    const { i18n, onMissing } = createI18n({ initialCache: { Hello: 'Hola' } });

    i18n.start();
    const p = root.querySelector('p')!;
    expect(p.textContent).toBe('Hola');

    // Let the stamping + text-swap mutations flush through several debounce
    // windows: our own writes must not trigger collection, reports, or a loop.
    await sleep(250);

    expect(onMissing).not.toHaveBeenCalled();
    expect(p.textContent).toBe('Hola');
    expect(p.getAttribute('translate')).toBe('no');
  });

  it("'protect-translations': stop(true) restores text AND removes only the markers we added", () => {
    root.innerHTML =
      '<p class="notranslate custom">Hello</p><p>Goodbye</p><p translate="yes">Welcome</p>';
    const { i18n } = createI18n({
      externalTranslation: 'protect-translations',
      initialCache: { Hello: 'Hola', Goodbye: 'Adiós', Welcome: 'Bienvenido' },
    });

    i18n.start();
    const [authored, plain, optedIn] = root.querySelectorAll('p');
    expect(authored!.textContent).toBe('Hola');
    expect(plain!.getAttribute('translate')).toBe('no');
    expect(plain!.classList.contains('notranslate')).toBe(true);
    // An author-supplied translate attribute is never overridden
    expect(optedIn!.getAttribute('translate')).toBe('yes');

    i18n.stop(true);

    expect(authored!.textContent).toBe('Hello');
    // Author-supplied classes are preserved; the translate we added is removed
    expect(authored!.className).toBe('notranslate custom');
    expect(authored!.hasAttribute('translate')).toBe(false);
    // An element we marked ourselves loses both markers — including the class
    // attribute itself, which only existed because we created it
    expect(plain!.hasAttribute('translate')).toBe(false);
    expect(plain!.hasAttribute('class')).toBe(false);
    // The author's opt-in survives untouched
    expect(optedIn!.getAttribute('translate')).toBe('yes');
    expect(optedIn!.classList.contains('notranslate')).toBe(false);
  });

  it("'block': start() stamps root translate='no', notranslate class, and the google meta", () => {
    const { i18n } = createI18n({ externalTranslation: 'block' });

    i18n.start();

    const html = document.documentElement;
    expect(html.getAttribute('translate')).toBe('no');
    expect(html.classList.contains('notranslate')).toBe(true);
    expect(
      document.head.querySelector('meta[name="google"][content="notranslate"]')
    ).not.toBeNull();

    // A root that had none of the three before start() gets all three removed again
    i18n.stop(true);
    expect(html.hasAttribute('translate')).toBe(false);
    expect(html.classList.contains('notranslate')).toBe(false);
    expect(document.head.querySelector('meta[name="google"][content="notranslate"]')).toBeNull();
  });

  it("'block': stop(true) restores the exact prior root state", () => {
    const html = document.documentElement;
    html.setAttribute('class', 'notranslate custom');
    html.setAttribute('translate', 'yes');
    const authorMeta = document.createElement('meta');
    authorMeta.setAttribute('name', 'google');
    authorMeta.setAttribute('content', 'notranslate');
    document.head.appendChild(authorMeta);

    const { i18n } = createI18n({ externalTranslation: 'block' });
    i18n.start();
    expect(html.getAttribute('translate')).toBe('no');
    // The author's meta is recognized — no duplicate is inserted
    expect(document.head.querySelectorAll('meta[name="google"][content="notranslate"]')).toHaveLength(1);

    i18n.stop(true);

    expect(html.getAttribute('translate')).toBe('yes');
    expect(html.getAttribute('class')).toBe('notranslate custom');
    expect(document.head.querySelectorAll('meta[name="google"][content="notranslate"]')).toHaveLength(1);
  });

  it("'block': suppression and element markers remain active (levels are cumulative)", async () => {
    root.innerHTML = '<p>Hello</p>';
    const { i18n, onMissing } = createI18n({
      externalTranslation: 'block',
      initialCache: { Hello: 'Hola' },
    });

    i18n.start();
    const p = root.querySelector('p')!;
    expect(p.textContent).toBe('Hola');
    // Element markers (protect-translations layer)
    expect(p.getAttribute('translate')).toBe('no');
    expect(p.classList.contains('notranslate')).toBe(true);

    // Suppression layer: the root block leaked (crbug 329233123) — the signal
    // still gates reporting as defense-in-depth.
    document.documentElement.classList.add('translated-ltr');
    const p2 = document.createElement('p');
    p2.textContent = 'こんにちは';
    root.appendChild(p2);
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
  });

  it("'block': root blocking and manageDirection save/restore independently", () => {
    const html = document.documentElement;
    html.setAttribute('dir', 'ltr');
    html.setAttribute('lang', 'en');
    html.setAttribute('translate', 'yes');

    const { i18n } = createI18n({
      externalTranslation: 'block',
      manageDirection: true,
      locale: 'he-IL',
    });

    i18n.start();
    expect(html.getAttribute('dir')).toBe('rtl');
    expect(html.getAttribute('lang')).toBe('he-IL');
    expect(html.getAttribute('translate')).toBe('no');
    expect(html.classList.contains('notranslate')).toBe(true);

    i18n.stop(true);
    expect(html.getAttribute('dir')).toBe('ltr');
    expect(html.getAttribute('lang')).toBe('en');
    expect(html.getAttribute('translate')).toBe('yes');
    expect(html.classList.contains('notranslate')).toBe(false);
  });

  it('detects a translator already engaged before start() (root class present)', async () => {
    document.documentElement.classList.add('translated-ltr');
    root.innerHTML = '<p>Content here</p>';
    const { i18n, onMissing } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start();
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
    expect(i18n.getExternalTranslationState().signals).toContain('chrome-translate');
  });

  it('detects pre-existing injected nodes on a deferred sweep', async () => {
    root.innerHTML =
      '<p>Original</p><font class="immersive-translate-target-wrapper">原文</font>';
    const { i18n, onMissing } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start();
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
    expect(i18n.getExternalTranslationState().signals).toContain('immersive-translate');
  });

  it('detects pre-existing Edge attributes on a deferred sweep', async () => {
    root.innerHTML = '<div _istranslated="1"><p>コンテンツ</p></div>';
    const { i18n, onMissing } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start();
    await flush();

    expect(onMissing).not.toHaveBeenCalled();
    expect(i18n.getExternalTranslationState().signals).toContain('edge-translate');
  });

  it('getExternalTranslationState() clears for non-sticky signals when the class is removed', async () => {
    const { i18n } = createI18n({ externalTranslation: 'suppress-reports' });
    i18n.start();

    document.documentElement.classList.add('translated-rtl');
    await sleep(30);
    expect(i18n.getExternalTranslationState()).toEqual({ active: true, signals: ['chrome-translate'] });

    document.documentElement.classList.remove('translated-rtl');
    await sleep(30);
    expect(i18n.getExternalTranslationState()).toEqual({ active: false, signals: [] });
  });

  it('stop() right after start() cancels the deferred sweep', async () => {
    root.innerHTML = '<font class="immersive-translate-target-wrapper">原文</font>';
    const { i18n } = createI18n({ externalTranslation: 'suppress-reports' });

    i18n.start();
    i18n.stop();
    await flush();

    expect(i18n.getExternalTranslationState().active).toBe(false);
  });
});
