import { describe, expect, it } from 'vitest';
import {
  collectDouyinSnapshot,
  deepCollectDouyinSnapshot,
} from '../src/adapters/douyin/collector';
import type { CollectedSnapshot } from '../src/adapters/douyin/collector';

/**
 * Regression cover for the deep dig's ReferenceError.
 *
 * The bug: `deepCollectDouyinSnapshot` ended with a call to module-scope
 * `collectDouyinSnapshot`. `chrome.scripting.executeScript({ func })` serializes
 * the func via `Function.prototype.toString()`, which carries only the func's
 * own source — module references become undefined identifiers in the page, so
 * EVERY deep dig threw `ReferenceError` in the tab and the handler surfaced it
 * as "抖音页面未返回可解析的作品数据" / "抖音页面采集异常".
 *
 * These tests fail on any reintroduction of a free identifier: the func is
 * rebuilt inside `new Function`, where module scope does not exist.
 */

/** Build the collector the way executeScript delivers it: bare source, no module scope. */
function isolatedDeepCollect(): (maxItems: number, maxScrolls: number) => Promise<unknown> {
  // new Function creates the func in global scope only — imports and the
  // module's other exports are invisible inside it.
  return new Function(
    'return (' + deepCollectDouyinSnapshot.toString() + ')',
  )() as typeof deepCollectDouyinSnapshot;
}

/** Minimal fake of the creator page the deep collector scrapes. */
function fakeDouyinPage() {
  const makeAnchor = (id: number) => {
    const anchor = {
      getAttribute: (k: string) => (k === 'href' ? `/video/${String(id).padStart(19, '7')}` : null),
      parentElement: null as unknown,
      tagName: 'A',
    };
    // The collector walks up to the <li> card to reach cover images.
    const card = {
      tagName: 'LI',
      parentElement: { tagName: 'UL', parentElement: null },
      querySelectorAll: (sel: string) => (sel === 'img' ? [] : []),
      innerText: `作品 ${id}`,
    };
    anchor.parentElement = card;
    return anchor;
  };
  const grid = {
    querySelectorAll: (sel: string) =>
      sel.includes('a[') ? [makeAnchor(1), makeAnchor(2)] : [],
  };
  return {
    querySelector: (sel: string) =>
      sel.includes('user-post-list')
        ? grid
        : sel.includes('user-detail')
          ? { querySelector: () => null }
          : null,
    querySelectorAll: () => [],
    body: { innerText: '页面正文' },
    documentElement: { scrollHeight: 0 },
    title: '小江没烦恼儿的抖音 - 抖音',
  };
}

describe('deep collector survives serialization (no free identifiers)', () => {
  it('scrapes works when rebuilt in an empty scope', async () => {
    const prevDoc = globalThis.document;
    const prevLoc = globalThis.location;
    const page = fakeDouyinPage();
    Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', {
      value: {
        pathname: '/user/MS4wLjABAAAAfakeSecUidForTest0000000000',
        href: 'https://www.douyin.com/user/MS4wLjABAAAAfakeSecUidForTest0000000000',
      },
      configurable: true,
      writable: true,
    });
    try {
      const result = (await isolatedDeepCollect()(5, 0)) as {
        items: unknown[];
        authorName: string;
        secUid: string;
      };
      // 0 scroll rounds: straight to the scrape core, which must still work.
      expect(result.items.length).toBe(2);
      expect(result.authorName).toBe('小江没烦恼儿');
      expect(result.secUid).toBe('MS4wLjABAAAAfakeSecUidForTest0000000000');
    } finally {
      Object.defineProperty(globalThis, 'document', { value: prevDoc, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'location', { value: prevLoc, configurable: true, writable: true });
    }
  });

  it('marks saturation when scrolling yields nothing new', async () => {
    const prevDoc = globalThis.document;
    const prevLoc = globalThis.location;
    const page = fakeDouyinPage();
    Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', {
      value: { pathname: '/user/x', href: 'https://www.douyin.com/user/x' },
      configurable: true,
      writable: true,
    });
    // scrollGrid touches window (window.scrollTo); stub it like a page would.
    const prevWin = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      scrollTo: () => undefined,
    };
    try {
      // 5 scroll rounds against a static fake: 3 quiet rounds → saturated.
      const result = (await isolatedDeepCollect()(5, 5)) as { saturated: boolean };
      expect(result.saturated).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'document', { value: prevDoc, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'location', { value: prevLoc, configurable: true, writable: true });
      (globalThis as Record<string, unknown>).window = prevWin;
    }
  });
});

describe('shallow and deep collectors stay in structural sync', () => {
  it('produce the same scrape core output shape on the same page', async () => {
    const page = fakeDouyinPage();
    const prevDoc = globalThis.document;
    const prevLoc = globalThis.location;
    Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', {
      value: {
        pathname: '/user/MS4wLjABAAAAfakeSecUidForTest0000000000',
        href: 'https://www.douyin.com/user/MS4wLjABAAAAfakeSecUidForTest0000000000',
      },
      configurable: true,
      writable: true,
    });
    try {
      const shallow = collectDouyinSnapshot(5);
      const deep = (await isolatedDeepCollect()(5, 0)) as CollectedSnapshot;
      expect(Object.keys(deep).sort()).toEqual(Object.keys(shallow).sort());
      expect(deep.items).toEqual(shallow.items);
      expect(deep.authorName).toEqual(shallow.authorName);
    } finally {
      Object.defineProperty(globalThis, 'document', { value: prevDoc, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'location', { value: prevLoc, configurable: true, writable: true });
    }
  });
});
