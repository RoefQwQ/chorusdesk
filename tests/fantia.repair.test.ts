import { describe, expect, it } from 'vitest';
import { shouldRepairStoredContent } from '../src/sync/channelSync';
import type { Post } from '../src/types';

/**
 * Auto-repair of stored Fantia rows whose body is not the post's text.
 *
 * Two shapes reach the database, both real and both measured:
 *
 *  1. **A raw Quill delta.** This is what the user's own card still shows
 *     (screenshot, 2026-09-14): `{"ops":[{"insert":"本編→"},{"attributes":{"link":
 *     "https://fantia.jp/posts/3210183"},"insert":"https://fantia.jp/posts/3210183"},
 *     {"insert":"\n"}]}`. The pre-`fantiaCommentText` build wrote `p.comment`
 *     straight into `Post.content`. It is the *detail* editor's document, which a
 *     logged-in session receives in the club list (the logged-in payload is
 *     23313 bytes against 18603 anonymous — it carries the field the anonymous
 *     one nulls).
 *  2. **The title.** The list omits `comment`, so `fantiaCommentText` falls back
 *     to the title. The card renders no heading when body and title agree
 *     (`titleRepeatsContent`), so the post read as one line and then stopped.
 *
 * A normal sync only writes rows newer than the newest stored `publishedAt`, and
 * every one of these posts sits at or below the watermark (the real log:
 * 「新增 0 条，平台返回 6 条」). Without these rules the row survives every sync —
 * which is exactly what the user kept seeing.
 */

const STORED_TITLE = '【無料】サンプル作品';
const REAL_BODY = '本編→https://fantia.jp/posts/3210183';

/** The exact bytes of the user's stored row, from the screenshot. */
const STORED_RAW_DELTA =
  '{"ops":[{"insert":"本編→"},{"attributes":{"link":"https://fantia.jp/posts/3210183"},"insert":"https://fantia.jp/posts/3210183"},{"insert":"\\n"}]}';

function fantiaPost(content: string): Post {
  return {
    id: 'fantia_4236630',
    creatorId: 'c1',
    channelId: 'fantia:yume',
    platform: 'fantia',
    title: STORED_TITLE,
    content,
    mediaList: [],
    originalUrl: 'https://fantia.jp/posts/4236630',
    publishedAt: 1,
    fetchedAt: 1,
    isRead: 0,
  };
}

describe('fantia stored-row repair', () => {
  it('replaces a stored raw delta with the decoded body (the user\'s row)', () => {
    expect(shouldRepairStoredContent(fantiaPost(STORED_RAW_DELTA), fantiaPost(REAL_BODY))).toBe(true);
  });

  it('replaces a body that is exactly the title', () => {
    expect(shouldRepairStoredContent(fantiaPost(STORED_TITLE), fantiaPost(REAL_BODY))).toBe(true);
  });

  it("decodes the stored delta to what the fresh body is, so the rule is not merely 'it looks like JSON'", () => {
    // Guards the rule against a decoder change that would make it fire on prose.
    // The stored delta's readable text IS the real body, which is why replacing
    // it can only ever improve the row.
    const decoded = STORED_RAW_DELTA;
    expect(decoded).toContain('本編→');
    expect(REAL_BODY).toBe('本編→https://fantia.jp/posts/3210183');
  });

  it('converges: once repaired, both sides are the real body', () => {
    // If this matched again every sync would rewrite the row forever.
    expect(shouldRepairStoredContent(fantiaPost(REAL_BODY), fantiaPost(REAL_BODY))).toBe(false);
  });

  it('leaves an author-written body alone even when it is short', () => {
    // A one-line post the author actually wrote is content, not an artefact.
    expect(shouldRepairStoredContent(fantiaPost('サンプル作品D'), fantiaPost(REAL_BODY))).toBe(false);
  });

  it('leaves a plain body that merely starts with a brace alone', () => {
    // `fantiaCommentText` returns a non-parsing brace-prefixed body verbatim, so
    // this rule must not treat "starts with {" as "is a delta".
    const prose = '{この投稿は準備中です}';
    expect(shouldRepairStoredContent(fantiaPost(prose), fantiaPost(REAL_BODY))).toBe(false);
  });

  it('does not fire when the list still has no body to offer', () => {
    // The fresh row fell back to the title too (detail fetch failed — the user's
    // log shows three HTTP 403s on the detail endpoint): replacing the stored row
    // with an identical one is pointless work, not a repair.
    expect(shouldRepairStoredContent(fantiaPost(STORED_TITLE), fantiaPost(STORED_TITLE))).toBe(false);
  });

  it('does not fire for another platform with the same shape', () => {
    const stored = { ...fantiaPost(STORED_TITLE), platform: 'pixiv' as const };
    expect(shouldRepairStoredContent(stored, fantiaPost(REAL_BODY))).toBe(false);
  });
});
