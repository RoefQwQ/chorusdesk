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
 *
 * WHY NOT THE API — this is a settled decision, not an oversight. Douyin's web
 * API needs `a_bogus` / `X-Bogus` / `__signature`, which are produced by an
 * obfuscated JS VM fed with `msToken`, `ttwid` and device/signature state. That
 * is exactly the state this file refuses to touch, and reproducing it would
 * reclassify the extension. Reading the rendered page instead is the whole point.
 * A background `bgFetch` of a creator page returns an anti-bot JS challenge shell
 * with no data, which is why acquisition runs in a tab at all.
 *
 * The full survey (official API limits, the signing schemes, the community's
 * recommended approach, and the one open question about embedded page data) is in
 * `docs/DOUYIN_RESEARCH_2026-09.md`. Read it before proposing a new approach here.
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
  /**
   * The work count the profile header states ("作品 29"), when present.
   *
   * **It counts works the author has hidden**, so it is NOT the number a visitor
   * can see and NOT a completeness oracle (confirmed against a real creator,
   * 2026-09-11). A shortfall against it is the normal state of any profile with
   * hidden works.
   *
   * It is kept only as a one-way signal: loading *at least* this many proves the
   * grid is complete, while loading fewer proves nothing. See the adapter's
   * `truncated` computation for why the asymmetry is deliberate.
   */
  statedTotal: number | null;
  /** True when scrolling stopped producing new works (deep collect only). */
  saturated: boolean;
}

/**
 * Wait for the creator's work grid to actually render, in the page.
 *
 * Also stringified and injected, so it is self-contained for the same reasons as
 * the collector. Necessary because the grid is client-rendered: the service
 * worker can only see the tab's load event, and loading is not rendering. A fixed
 * post-load sleep raced the page and lost on cold loads — measured as two of
 * three channels reporting an empty grid while a third, which happened to load
 * more slowly, succeeded.
 *
 * Resolves `true` once the grid holds at least one work, or `false` at the
 * deadline. Returning rather than throwing means the caller still scrapes (the
 * page may carry a captcha or an auth wall, which the collector detects and
 * reports more usefully than a timeout would).
 */
export async function awaitDouyinGrid(maxWaitMs: number): Promise<boolean> {
  const ready = (): boolean => {
    const grid = document.querySelector('[data-e2e="user-post-list"]');
    if (!grid) return false;
    return grid.querySelectorAll('a[href*="/video/"], a[href*="/note/"]').length > 0;
  };

  const deadline = Date.now() + maxWaitMs;
  if (ready()) return true;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (ready()) return true;
  }
  return false;
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

  // The header states the creator's total work count ("作品 29"). Captured so the
  // adapter can detect a grid that stopped short of it.
  //
  // Two elements can carry it: the profile tab ("作品 29") and, on some layouts,
  // the count chip inside the grid header. Read both and keep the largest plain
  // integer — an anonymous page sometimes renders a 0/absent tab count while the
  // grid itself shows the real total, and under-reporting here is what makes the
  // adapter mistake a login-truncated grid for a complete one (and park the dig
  // cursor at __END__, permanently hiding the older works).
  let statedTotal: number | null = null;
  const countCandidates = document.querySelectorAll(
    '[data-e2e="user-tab-count"], [data-e2e="user-post-count"]',
  );
  for (const candidate of Array.from(countCandidates)) {
    const raw = text((candidate as HTMLElement).innerText, 20);
    // Plain integers only: Douyin abbreviates large counts ("5.9万"), and a
    // guessed expansion would produce a bogus completeness check.
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      if (statedTotal === null || value > statedTotal) statedTotal = value;
    }
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
    statedTotal,
    saturated: false,
  };
}

/**
 * Deep collect: scroll the grid until it stops yielding new works, then scrape.
 *
 * Why this is not just `collectDouyinSnapshot` in a loop: the creator page does
 * NOT scroll the window. The grid lives inside `.route-scroll-container`, whose
 * own `scrollTop` drives the lazy loader — a `window.scrollTo` never triggers it,
 * which is what made the original spike conclude Douyin had no usable pagination.
 *
 * Anonymous browsing stops the grid growing at some point, so `saturated` reports
 * only that scrolling stopped helping. Whether that means "reached the end" or
 * "blocked" is decided by the adapter.
 *
 * **The original "login wall" evidence is now in doubt.** The spike that
 * introduced this recorded "18 of a stated 29 works, then nothing however far it
 * scrolls" — but the stated count includes works the author has hidden (confirmed
 * 2026-09-11), so 18 visible with 29 stated may simply have been 11 hidden works
 * and a complete grid. Do not treat that measurement as proof that anonymous
 * browsing is truncated; it is not established. See
 * `docs/DOUYIN_RESEARCH_2026-09.md`.
 *
 * SELF-CONTAINMENT IS LOAD-BEARING. This function is serialized by
 * `chrome.scripting.executeScript({ func })` via `Function.prototype.toString()`,
 * which carries ONLY this function's own source. Any reference to module scope
 * (like calling `collectDouyinSnapshot` below) becomes an undefined identifier
 * in the page and throws `ReferenceError` on every dig. The scrape core is
 * therefore duplicated here on purpose; the shallow collector cannot be shared
 * into the injected context by any other means (module imports, closures, and
 * `new Function`/eval are all unavailable or CSP-blocked in the page).
 */
export async function deepCollectDouyinSnapshot(
  maxItems: number,
  maxScrolls: number,
): Promise<CollectedSnapshot> {
  const countWorks = (): number => {
    const grid = document.querySelector('[data-e2e="user-post-list"]');
    if (!grid) return 0;
    const hrefs = Array.from(grid.querySelectorAll('a[href*="/video/"], a[href*="/note/"]'))
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => /\/(?:video|note)\/\d{15,25}/.test(h));
    return new Set(hrefs).size;
  };

  /** Drive every scrollable ancestor of the grid, plus the last card into view. */
  const scrollGrid = (): void => {
    const grid = document.querySelector('[data-e2e="user-post-list"]');
    if (grid) {
      const cards = grid.querySelectorAll('li');
      if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'end' });
      // Walk ancestors rather than scanning the whole document: only a container
      // that actually holds the grid can be the feed's scroller.
      let node: HTMLElement | null = grid as HTMLElement;
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) node.scrollTop = node.scrollHeight;
        node = node.parentElement;
      }
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  };

  let stagnant = 0;
  let previous = countWorks();
  let saturated = false;

  for (let round = 0; round < maxScrolls; round++) {
    if (previous >= maxItems) break;
    scrollGrid();
    // The lazy loader needs a moment; 900ms matches the pacing the sync layer
    // already uses between paginated requests.
    const { promise: settle, resolve: settled } = Promise.withResolvers<void>();
    setTimeout(settled, 900);
    await settle;
    const current = countWorks();
    if (current <= previous) {
      stagnant++;
      // Three quiet rounds: the grid is done growing, whether finished or gated.
      if (stagnant >= 3) {
        saturated = true;
        break;
      }
    } else {
      stagnant = 0;
    }
    previous = current;
  }

  // Scrape core — duplicated from `collectDouyinSnapshot` by injection
  // constraint (see the doc comment above); keep the two in sync on purpose.
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

  let statedTotal: number | null = null;
  const countCandidates = document.querySelectorAll(
    '[data-e2e="user-tab-count"], [data-e2e="user-post-count"]',
  );
  for (const candidate of Array.from(countCandidates)) {
    const raw = text((candidate as HTMLElement).innerText, 20);
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      if (statedTotal === null || value > statedTotal) statedTotal = value;
    }
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
    statedTotal,
    saturated,
  };
}
