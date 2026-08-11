import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountInfoHotspots, type InfoHotspotData } from './info-hotspots.js';
import type { PanoViewer } from '../PanoViewer.js';

// This package's vitest config runs under Node, not jsdom (see
// vitest.config.ts) — deliberately, so the package pays for no DOM test
// dependency. info-hotspots.ts is DOM-driven, so this test builds the minimal
// stand-in the module actually touches (element creation, style/attribute
// setters, tree insertion, innerHTML/textContent) rather than adding jsdom as
// a new devDependency.
class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  id = '';
  title = '';
  type = '';
  onclick: (() => void) | null = null;
  onpointerenter: (() => void) | null = null;
  onpointerleave: (() => void) | null = null;
  private _innerHTML = '';
  private _textContent = '';

  constructor(tagName: string) {
    this.tagName = tagName;
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }
  remove(): void {
    // No parent tracking needed for these tests.
  }
  setAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(v: string) {
    this._innerHTML = v;
  }
  get textContent(): string {
    return this._textContent;
  }
  set textContent(v: string) {
    this._textContent = v;
  }
}

function installFakeDocument(): { created: FakeElement[] } {
  const created: FakeElement[] = [];
  const head = new FakeElement('head');
  const fakeDocument = {
    createElement(tag: string) {
      const el = new FakeElement(tag);
      created.push(el);
      return el;
    },
    head,
    getElementById(id: string) {
      return created.find((e) => e.id === id) ?? null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal('document', fakeDocument);
  return { created };
}

/** Build a viewer stub carrying just the surface mountInfoHotspots touches. */
function makeViewerStub(container: FakeElement): PanoViewer {
  return {
    el: container,
    addHotspot: () => ({ remove: () => {}, update: () => {} }),
  } as unknown as PanoViewer;
}

describe('mountInfoHotspots', () => {
  let created: FakeElement[];

  beforeEach(() => {
    ({ created } = installFakeDocument());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function openPanelFor(data: InfoHotspotData): FakeElement {
    const container = new FakeElement('div');
    const viewer = makeViewerStub(container);
    mountInfoHotspots(viewer, [data]);
    const btn = created.find((e) => e.tagName === 'button' && e.title === data.title);
    if (!btn?.onclick) throw new Error('marker button not created');
    btn.onclick();
    const panel = created.find((e) => e.tagName === 'aside');
    if (!panel) throw new Error('panel not created');
    // panel.append(close, header, bodyEl) — bodyEl is the third child.
    const bodyEl = panel.children[2];
    if (!bodyEl) throw new Error('panel body not created');
    return bodyEl;
  }

  it('renders the Markdown body through renderMarkdown, escaping HTML', () => {
    const bodyEl = openPanelFor({
      yaw: 0,
      pitch: 0,
      title: 'Spot',
      body: '<img src=x onerror=alert(1)>',
    });
    expect(bodyEl.innerHTML).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('does not accept an html field as a raw innerHTML escape hatch', () => {
    const bodyEl = openPanelFor({
      yaw: 0,
      pitch: 0,
      title: 'Spot',
      body: 'safe body',
      // `html` is intentionally not part of InfoHotspotData; a consumer that
      // still passes it (e.g. from untyped JS, or JSON parsed as `any`) must
      // not have it reach innerHTML unsanitized.
      ...({ html: '<img src=x onerror=alert(1)>' } as Record<string, unknown>),
    } as InfoHotspotData);
    expect(bodyEl.innerHTML).not.toContain('onerror');
    expect(bodyEl.innerHTML).toBe('<p>safe body</p>');
  });
});
