import { describe, expect, it } from 'vitest';
import { shouldRepairStoredContent } from '../src/sync/channelSync';
import type { Post } from '../src/types';

/**
 * Auto-repair of xiaohongshu rows whose note link is missing its `xsec_token`.
 *
 * The adapter built `https://www.xiaohongshu.com/explore/<id>` with no query
 * string, so every stored `originalUrl` was the tokenless form. Clicking one lands
 * on `/404` with `error_code=300031` 「当前笔记暂时无法浏览」 — the reported bug. A
 * working link, taken from the user's own browser, looks like:
 *
 *   …/explore/<id>?xsec_token=ABlMm1ZU…&xsec_source=pc_user
 *
 * Measured 2026-09-13 on a real profile response: `noteCard.xsecToken` is present
 * on all 30 notes and identical across them — a session/profile-scoped token, not
 * a per-note one.
 *
 * A normal sync never rewrites existing rows (rule 16), so the adapter fix alone
 * would leave every already-stored link broken. Hence a repair rule, and it has to
 * be derived from the shape the bug actually wrote rather than from "looks like a
 * xiaohongshu link": the stored value must be the BARE `explore/<24-hex>` URL with
 * no query at all, and the fresh one the same path plus a token. That way a link
 * the user edited, a share URL with unrelated parameters, or a different note can
 * never match — the replacement can only add what was missing.
 */

const NOTE_ID = '6aa3c9100000000025037cae';
const TOKEN = 'ABlMm1ZUf3-i7vnIophIdgSYsFlWr7xkC_DbuTjRaMLcg=';

function xhsPost(originalUrl: string): Post {
  return {
    id: `xiaohongshu_${NOTE_ID}`,
    creatorId: 'c1',
    channelId: 'xiaohongshu:u1',
    platform: 'xiaohongshu',
    title: '示例笔记',
    content: '示例笔记',
    mediaList: [],
    originalUrl,
    publishedAt: 1,
    fetchedAt: 1,
    isRead: 0,
  } as Post;
}

const STORED = `https://www.xiaohongshu.com/explore/${NOTE_ID}`;
const FRESH = `${STORED}?xsec_token=${encodeURIComponent(TOKEN)}&xsec_source=pc_user`;

describe('repairing a xiaohongshu note link', () => {
  it('rewrites the bare link the bug stored', () => {
    expect(shouldRepairStoredContent(xhsPost(STORED), xhsPost(FRESH))).toBe(true);
  });

  it('leaves an already-correct link alone', () => {
    // Converges: after the repair both sides are the tokenized form.
    expect(shouldRepairStoredContent(xhsPost(FRESH), xhsPost(FRESH))).toBe(false);
  });

  it('does not touch a link that merely has a query string', () => {
    // Any query at all means this is NOT the shape the bug wrote — it could be a
    // share link the user pasted, and overwriting it would discard their value.
    const withOtherParam = `${STORED}?foo=bar`;
    expect(shouldRepairStoredContent(xhsPost(withOtherParam), xhsPost(FRESH))).toBe(false);
  });

  it('does not follow a fresh link to a different note', () => {
    const other = `https://www.xiaohongshu.com/explore/6a9d43910000000026016dc7?xsec_token=x`;
    expect(shouldRepairStoredContent(xhsPost(STORED), xhsPost(other))).toBe(false);
  });

  it('ignores a fresh link with no token, and non-note paths', () => {
    const noToken = 'https://www.xiaohongshu.com/explore/6aa3c9100000000025037cae';
    expect(shouldRepairStoredContent(xhsPost(STORED), xhsPost(noToken))).toBe(false);
    expect(
      shouldRepairStoredContent(xhsPost(STORED), xhsPost('https://www.xiaohongshu.com/user/profile/63799a')),
    ).toBe(false);
  });

  it('ignores another host and a malformed stored value', () => {
    const elsewhere = `https://evil.example/explore/${NOTE_ID}?xsec_token=${TOKEN}`;
    expect(shouldRepairStoredContent(xhsPost(STORED), xhsPost(elsewhere))).toBe(false);
    expect(shouldRepairStoredContent(xhsPost('not a url'), xhsPost(FRESH))).toBe(false);
  });

  it('does not apply to other platforms', () => {
    const rss = { ...xhsPost(STORED), platform: 'rss' } as Post;
    const rssFresh = { ...xhsPost(FRESH), platform: 'rss' } as Post;
    expect(shouldRepairStoredContent(rss, rssFresh)).toBe(false);
  });
});
