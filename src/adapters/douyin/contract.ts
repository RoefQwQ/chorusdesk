/**
 * Douyin acquisition contract — the ONLY place that knows what a douyin.com page
 * looks like.
 *
 * Why this layer exists at all (2026-09 acquisition spike):
 *
 * A background `bgFetch` of `https://www.douyin.com/user/<sec_uid>` returns HTTP
 * 200 with a JS anti-bot challenge shell (`_$jsvmprt` obfuscated interpreter) and
 * ZERO structured data — no `aweme_id`, no `RENDER_DATA`, no SSR state. The
 * xiaohongshu approach (fetch HTML in the SW, parse `window.__INITIAL_STATE__`)
 * therefore cannot work for Douyin at all.
 *
 * In a real browser the creator page DOES render, and the work grid is plain DOM:
 *
 *   [data-e2e="user-post-list"] li a[href="/video/<aweme_id>"]
 *     img.src = signed cover (…?x-expires=…&x-signature=…)
 *     img.alt = "<nickname>：<description>"
 *
 * So acquisition is page-driven (`chrome.scripting.executeScript` into a real
 * douyin.com tab, the same pattern `twitterTimeline.ts` already uses), and this
 * module validates whatever that page hands back.
 *
 * Everything crossing this boundary is UNTRUSTED web content: the collector runs
 * in a page whose scripts we do not control. Nothing here touches the DB, the
 * Post type, or any chrome.* API — that is what keeps a Douyin markup change from
 * reaching Chorus core.
 */

/** Max works accepted from one snapshot. Bounds a hostile/huge page payload. */
export const MAX_ITEMS_PER_SNAPSHOT = 200;
/** Max images kept for one image post. Douyin caps galleries far below this. */
export const MAX_IMAGES_PER_ITEM = 35;
/** Max accepted length of any single free-text field, in characters. */
export const MAX_TEXT_LEN = 2000;
/** Max accepted length of any single URL, in characters. */
export const MAX_URL_LEN = 2048;

/** Douyin work ids are 18–19 digit snowflakes; allow a little slack. */
const AWEME_ID_RE = /^\d{15,25}$/;

/**
 * Hosts whose media a Post may reference. Kept in step with `PLATFORM_HOSTS`
 * (`hosts.ts`) and `host_permissions`: a URL the extension cannot proxy is a
 * broken thumbnail, so accepting a wider set here would only store dead links.
 */
const MEDIA_HOSTS = ['douyinpic.com'];

export type DouyinItemType = 'video' | 'image';

/**
 * One work as scraped from the page, before validation. Every field is
 * `unknown`-ish on purpose: this is the raw wire shape.
 */
export interface RawDouyinItem {
  awemeId?: unknown;
  type?: unknown;
  href?: unknown;
  description?: unknown;
  coverUrl?: unknown;
  imageUrls?: unknown;
  authorName?: unknown;
  statsLabel?: unknown;
}

/** The full page snapshot the collector returns. */
export interface RawDouyinSnapshot {
  secUid?: unknown;
  authorName?: unknown;
  authorAvatar?: unknown;
  pageUrl?: unknown;
  items?: unknown;
  /** Set by the collector when the grid rendered an explicit failure state. */
  gridError?: unknown;
  /** Set when the page showed a login wall / captcha instead of content. */
  requiresAuth?: unknown;
  requiresVerify?: unknown;
}

/** A single validated work. All fields are safe to persist. */
export interface DouyinItem {
  awemeId: string;
  type: DouyinItemType;
  /** Canonical, stable work page URL — never a CDN or signed URL. */
  pageUrl: string;
  description: string;
  publishedAt: number;
  coverUrl: string;
  imageUrls: string[];
  hashtags: string[];
}

/** A validated snapshot. */
export interface DouyinSnapshot {
  secUid: string;
  authorName: string;
  authorAvatar: string;
  items: DouyinItem[];
}

function asText(value: unknown, max = MAX_TEXT_LEN): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Accept only an absolute https(-upgradable) media URL on a known Douyin CDN.
 *
 * Query strings are preserved verbatim: Douyin cover URLs carry `x-expires` and
 * `x-signature` and 403 without them. Stripping "tracking params" would break
 * every image — so this validates the URL, it does not clean it.
 */
export function normalizeMediaUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if (!raw || raw.length > MAX_URL_LEN) return '';
  // Douyin emits protocol-relative CDN URLs; inside chrome-extension:// those
  // resolve against the extension scheme and break.
  if (raw.startsWith('//')) raw = `https:${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.username || url.password) return '';
  const host = url.hostname.toLowerCase();
  const known = MEDIA_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
  if (!known) return '';
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.toString();
}

/** True when `value` is a syntactically valid Douyin work id. */
export function isAwemeId(value: unknown): value is string {
  return typeof value === 'string' && AWEME_ID_RE.test(value.trim());
}

/**
 * Derive the publish time from the work id.
 *
 * A Douyin `aweme_id` is a snowflake whose high 32 bits are the creation time in
 * seconds — verified across works spanning 2022-05 … 2026-09 during the spike.
 * This is why V1 does not need a `create_time` field: the id is both the identity
 * AND the timestamp, so a page that stops rendering dates cannot corrupt ordering.
 *
 * Returns 0 when the id does not yield a plausible time, so callers can reject
 * the item rather than persist a NaN/epoch timestamp into an index.
 */
export function publishedAtFromAwemeId(awemeId: string): number {
  if (!isAwemeId(awemeId)) return 0;
  let seconds: number;
  try {
    seconds = Number(BigInt(awemeId.trim()) >> 32n);
  } catch {
    return 0;
  }
  if (!Number.isFinite(seconds)) return 0;
  // 2016-01-01 … now + 1 day. Douyin launched in 2016; anything outside is not a
  // timestamp and must not reach the publishedAt index.
  const ms = seconds * 1000;
  if (ms < 1_451_606_400_000) return 0;
  if (ms > Date.now() + 86_400_000) return 0;
  return ms;
}

/** Extract the work id from a `/video/123`, `/note/123` or absolute Douyin URL. */
export function awemeIdFromHref(href: unknown): string {
  if (typeof href !== 'string') return '';
  const raw = href.trim();
  if (!raw || raw.length > MAX_URL_LEN) return '';
  const match = raw.match(/\/(?:video|note)\/(\d{15,25})/);
  if (match && isAwemeId(match[1])) return match[1];
  return '';
}

/** `/note/<id>` is Douyin's image-gallery route; `/video/<id>` is a short video. */
function typeFromHref(href: unknown, fallback: unknown): DouyinItemType {
  if (typeof href === 'string' && /\/note\/\d/.test(href)) return 'image';
  if (fallback === 'image' || fallback === 'note') return 'image';
  return 'video';
}

/**
 * The card's `img.alt` is `"<nickname>：<description>"`. Strip the author prefix
 * so the stored description is the caption alone.
 */
export function descriptionFromAlt(alt: unknown, authorName: unknown): string {
  const text = asText(alt);
  if (!text) return '';
  const name = asText(authorName, 120);
  if (name && text.startsWith(`${name}：`)) return text.slice(name.length + 1).trim();
  if (name && text.startsWith(`${name}:`)) return text.slice(name.length + 1).trim();
  return text;
}

/** Pull `#tag` tokens out of a caption, de-duplicated, order preserved. */
export function extractHashtags(description: string): string[] {
  if (!description) return [];
  const found = description.match(/#[^\s#@]{1,30}/g);
  if (!found) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of found) {
    const tag = raw.slice(1).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 20) break;
  }
  return tags;
}

/**
 * Validate one raw card. Returns `null` for anything without a usable identity
 * or timestamp — Chorus persists nothing it cannot dedupe or sort (AGENTS rule 6).
 */
export function normalizeItem(raw: RawDouyinItem, snapshotAuthor?: unknown): DouyinItem | null {
  if (!raw || typeof raw !== 'object') return null;

  const awemeId = isAwemeId(raw.awemeId) ? String(raw.awemeId).trim() : awemeIdFromHref(raw.href);
  if (!awemeId) return null;

  const publishedAt = publishedAtFromAwemeId(awemeId);
  if (!publishedAt) return null;

  const type = typeFromHref(raw.href, raw.type);
  const authorName = raw.authorName ?? snapshotAuthor;
  const description = descriptionFromAlt(raw.description, authorName);

  const coverUrl = normalizeMediaUrl(raw.coverUrl);

  const imageUrls: string[] = [];
  if (Array.isArray(raw.imageUrls)) {
    const seen = new Set<string>();
    for (const candidate of raw.imageUrls) {
      const url = normalizeMediaUrl(candidate);
      // Identical URLs are the same picture; keep first occurrence and order.
      if (!url || seen.has(url)) continue;
      seen.add(url);
      imageUrls.push(url);
      if (imageUrls.length >= MAX_IMAGES_PER_ITEM) break;
    }
  }

  return {
    awemeId,
    type,
    // Always the canonical work URL. Signed CDN URLs expire and must never
    // become a work's identity or its click target.
    pageUrl: `https://www.douyin.com/${type === 'image' ? 'note' : 'video'}/${awemeId}`,
    description,
    publishedAt,
    coverUrl,
    imageUrls,
    hashtags: extractHashtags(description),
  };
}

/**
 * Validate a whole page snapshot. Malformed items are dropped individually; the
 * snapshot itself is rejected (`null`) only when it carries no usable identity.
 */
export function normalizeSnapshot(raw: unknown): DouyinSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as RawDouyinSnapshot;

  const secUid = asText(snapshot.secUid, 200);
  if (!secUid) return null;

  const authorName = asText(snapshot.authorName, 120);
  const items: DouyinItem[] = [];
  const seen = new Set<string>();

  if (Array.isArray(snapshot.items)) {
    for (const rawItem of snapshot.items.slice(0, MAX_ITEMS_PER_SNAPSHOT)) {
      const item = normalizeItem(rawItem as RawDouyinItem, authorName);
      if (!item || seen.has(item.awemeId)) continue;
      seen.add(item.awemeId);
      items.push(item);
    }
  }

  // Newest first. The grid is roughly reverse-chronological but pinned works and
  // waterfall layout break strict ordering, so never trust the page's order.
  items.sort((a, b) => b.publishedAt - a.publishedAt);

  return {
    secUid,
    authorName,
    authorAvatar: normalizeMediaUrl(snapshot.authorAvatar),
    items,
  };
}
