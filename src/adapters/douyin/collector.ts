/**
 * The page-side Douyin collector.
 *
 * This function is stringified and injected into a real douyin.com tab by
 * `douyinSnapshot.ts` via `chrome.scripting.executeScript`. It therefore must be
 * self-contained: no imports, no closure over module scope, no extension APIs.
 *
 * It reads ONLY rendered DOM. It deliberately never touches `document.cookie`,
 * `localStorage`, `sessionStorage`, request headers, or any device/signature
 * state — the extension has no use for Douyin credentials, and not reading them
 * is what keeps this out of the "authenticated proxy" category.
 */

/** Shape returned to the background. Mirrors `RawDouyinSnapshot`. */
export interface CollectedSnapshot {
  secUid: string;
  authorName: string;
  authorAvatar: string;
  pageUrl: string;
  items: Array<{
    awemeId: string;
    type: 'video' | 'image';
    href: string;
    description: string;
    coverUrl: string;
    imageUrls: string[];
  }>;
  gridError: boolean;
  requiresAuth: boolean;
  requiresVerify: boolean;
}

/**
 * Scrape the creator page. Runs in the page; returns a plain serializable object.
 *
 * `maxItems` bounds the payload that crosses back into the extension.
 */
export function collectDouyinSnapshot(maxItems: number): CollectedSnapshot {
  const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  };

  const secUidFromPath = (): string => {
    const match = location.pathname.match(/\/user\/([A-Za-z0-9_-]{6,200})/);
    return match ? match[1] : '';
  };

  const grid = document.querySelector('[data-e2e="user-post-list"]');
  const detail = document.querySelector('[data-e2e="user-detail"]');

  // Douyin renders an explicit failure state in the grid rather than an HTTP
  // error when the list request is rejected. Detecting it is what lets the
  // adapter report `parse`/`rate_limit` instead of a silent "0 new posts".
  const gridText = grid ? text((grid as HTMLElement).innerText, 400) : '';
  const gridError = /服务异常|重新刷新|加载失败|出错了/.test(gridText);

  const bodyText = document.body ? text(document.body.innerText, 3000) : '';
  const requiresVerify = Boolean(
    document.querySelector('#captcha_container, .captcha_verify_container, .verify-wrap'),
  );
  const requiresAuth = /用户不存在|登录后|请先登录/.test(bodyText) && !grid;

  let authorName = '';
  const heading = document.querySelector('[data-e2e="user-detail"] h1');
  if (heading) authorName = text((heading as HTMLElement).innerText, 120);
  if (!authorName) {
    const title = text(document.title, 120);
    // Page title is "<nickname>的抖音 - 抖音".
    const match = title.match(/^(.+?)的抖音/);
    if (match) authorName = text(match[1], 120);
  }

  let authorAvatar = '';
  const avatarImg = detail?.querySelector('img');
  if (avatarImg) authorAvatar = text(avatarImg.getAttribute('src'), 2048);

  const items: CollectedSnapshot['items'] = [];
  const seen = new Set<string>();
  const anchors = grid
    ? Array.from(grid.querySelectorAll('a[href*="/video/"], a[href*="/note/"]'))
    : [];

  for (const anchor of anchors) {
    if (items.length >= maxItems) break;
    const href = text(anchor.getAttribute('href'), 2048);
    const match = href.match(/\/(video|note)\/(\d{15,25})/);
    if (!match) continue;
    const awemeId = match[2];
    if (seen.has(awemeId)) continue;
    seen.add(awemeId);

    // Walk up to the card (an <li> in the grid) to reach the cover and caption.
    let card: HTMLElement = anchor as HTMLElement;
    for (let i = 0; i < 8 && card.parentElement && card !== grid; i++) {
      if (card.tagName === 'LI') break;
      card = card.parentElement;
    }
    if (card === grid) card = anchor as HTMLElement;

    const images = Array.from(card.querySelectorAll('img'));
    const coverUrl = images.length ? text(images[0].getAttribute('src'), 2048) : '';
    // The caption lives in the cover's alt as "<nickname>：<caption>"; the
    // normalizer strips the prefix. Fall back to card text when alt is absent.
    let description = images.length ? text(images[0].getAttribute('alt'), 2000) : '';
    if (!description) description = text((card as HTMLElement).innerText, 2000);

    const imageUrls: string[] = [];
    if (match[1] === 'note') {
      for (const img of images) {
        const src = text(img.getAttribute('src'), 2048);
        if (src && !imageUrls.includes(src)) imageUrls.push(src);
        if (imageUrls.length >= 35) break;
      }
    }

    items.push({
      awemeId,
      type: match[1] === 'note' ? 'image' : 'video',
      href,
      description,
      coverUrl,
      imageUrls,
    });
  }

  return {
    secUid: secUidFromPath(),
    authorName,
    authorAvatar,
    pageUrl: location.href,
    items,
    gridError: gridError && items.length === 0,
    requiresAuth,
    requiresVerify,
  };
}
