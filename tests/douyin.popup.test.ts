import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectDouyinSnapshot } from '../src/adapters/douyin/collector';
import { usePageDetection } from '../entrypoints/popup/composables/usePageDetection';

/**
 * Regression cover for popup quick-follow on Douyin.
 *
 * The bug: `usePageDetection`'s generic in-page script has branches for YouTube,
 * X, Bilibili, Xiaohongshu and Weibo but none for Douyin, and its meta-tag
 * fallback does not substitute — a Douyin creator page's og:title is the site
 * name and its og:image is not the avatar. Quick-follow therefore showed the
 * "抖音用户_xxxxxx" placeholder and a letter avatar even though the sec_uid had
 * parsed correctly.
 *
 * These tests drive the composable with a stubbed `chrome.scripting` that runs
 * the real collector against a minimal fake of the observed page structure.
 */

/** Minimal stand-in for the observed creator-page DOM. */
function fakeDouyinPage(options: { name?: string; avatar?: string } = {}) {
  const { name = '小江没烦恼儿', avatar = 'https://p3-pc.douyinpic.com/img/aweme-avatar/tos-cn-avt-0015_x~c5_300x300.jpeg' } = options;

  const heading = name ? { innerText: name } : null;
  const avatarImg = avatar ? { getAttribute: (k: string) => (k === 'src' ? avatar : null) } : null;
  const detail = {
    innerText: `${name}\n关注\n845\n粉丝\n5.9万`,
    querySelector: (sel: string) => (sel === 'img' ? avatarImg : null),
    querySelectorAll: () => [],
  };

  return {
    querySelector: (sel: string) => {
      if (sel === '[data-e2e="user-detail"] h1') return heading;
      if (sel === '[data-e2e="user-detail"]') return detail;
      if (sel === '[data-e2e="user-post-list"]') return { innerText: '', querySelectorAll: () => [] };
      return null;
    },
    // The collector reads the work-count candidates with querySelectorAll;
    // the popup fake has no count chips, so it reports none.
    querySelectorAll: () => [],
    title: `${name}的抖音 - 抖音`,
    body: { innerText: `${name}\n关注` },
  };
}

/** Run the real collector against a fake page, as executeScript would. */
function runCollector(page: ReturnType<typeof fakeDouyinPage>, maxItems: number) {
  const prevDoc = globalThis.document;
  const prevLoc = globalThis.location;
  Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { pathname: '/user/MS4wLjABAAAAsyntheticSecUid', href: 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid' },
    configurable: true,
    writable: true,
  });
  try {
    return collectDouyinSnapshot(maxItems);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: prevDoc, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', { value: prevLoc, configurable: true, writable: true });
  }
}

function stubChrome(page: ReturnType<typeof fakeDouyinPage> | null) {
  const executeScript = vi.fn(async ({ func, args }: { func: unknown; args?: unknown[] }) => {
    if (!page) return [{ result: null }];
    const maxItems = Number((args as number[])?.[0] ?? 0);
    // Only the Douyin collector is expected on this path.
    expect(func).toBe(collectDouyinSnapshot);
    return [{ result: runCollector(page, maxItems) }];
  });
  (globalThis as Record<string, unknown>).chrome = { scripting: { executeScript } };
  return executeScript;
}

describe('popup quick-follow — douyin author meta', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('recovers the real nickname and avatar instead of the placeholder', async () => {
    const executeScript = stubChrome(fakeDouyinPage());
    const page = usePageDetection();
    page.resolveUrl('https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid');

    const name = await page.extractActiveTabAuthorMeta(7, 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid');

    expect(name).toBe('小江没烦恼儿');
    expect(page.detectedAuthorMeta.value.name).toBe('小江没烦恼儿');
    expect(page.detectedAuthorMeta.value.avatar).toContain('douyinpic.com');
    // The displayed name must be the real nickname, never 抖音用户_xxxxxx.
    expect(page.activeDisplayName.value).toBe('小江没烦恼儿');
    expect(page.activeDisplayName.value.startsWith('抖音用户_')).toBe(false);
    expect(executeScript).toHaveBeenCalledOnce();
  });

  it('asks the collector for author identity only, not the work grid', async () => {
    const executeScript = stubChrome(fakeDouyinPage());
    const page = usePageDetection();
    page.resolveUrl('https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid');
    await page.extractActiveTabAuthorMeta(7, 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid');

    // maxItems 0 keeps quick-follow from scraping posts it does not need.
    expect(executeScript.mock.calls[0][0]).toMatchObject({ args: [0] });
  });

  it('falls back to the parsed placeholder when the page yields no nickname', async () => {
    stubChrome(fakeDouyinPage({ name: '', avatar: '' }));
    const page = usePageDetection();
    page.resolveUrl('https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid');

    const name = await page.extractActiveTabAuthorMeta(7, 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid');

    expect(name).toBeUndefined();
    // Degrades to the suggested placeholder rather than throwing or blanking.
    expect(page.activeDisplayName.value.startsWith('抖音用户_')).toBe(true);
  });

  it('survives an injection that returns nothing', async () => {
    stubChrome(null);
    const page = usePageDetection();
    page.resolveUrl('https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid');

    await expect(
      page.extractActiveTabAuthorMeta(7, 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid'),
    ).resolves.toBeUndefined();
    expect(page.detectedAuthorMeta.value.name).toBeUndefined();
  });

  it('does not inject into a privileged or unknown tab URL', async () => {
    const executeScript = stubChrome(fakeDouyinPage());
    const page = usePageDetection();
    page.resolveUrl('https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUid');

    await page.extractActiveTabAuthorMeta(7, 'chrome://extensions/');
    await page.extractActiveTabAuthorMeta(7, undefined);

    expect(executeScript).not.toHaveBeenCalled();
  });
});
