import { describe, expect, it } from 'vitest';
import { isRssBodySuperseded, shouldRepairStoredContent } from '../src/sync/channelSync';
import type { Post } from '../src/types';

/**
 * Auto-repair of RSS rows that stored the feed's SUMMARY instead of the article.
 *
 * The adapter used to read `<description>`, which feeds commonly truncate
 * themselves. Measured against a real newsletter feed, that summary was 359
 * characters ending in a single "…" while `<content:encoded>` held the full
 * article (31144 characters of markup, 3.7k-14.9k of plain text). Users who had
 * already synced those items kept the summary, because a normal sync never
 * rewrites existing rows.
 *
 * An earlier attempt keyed the repair off "stored length is exactly 353 and ends
 * with `...`" — the fingerprint of a 350-character cap. It never matched a single
 * row, because the data was the feed's own summary rather than the cap's output.
 * The rule below is derived from the data instead of from an assumption about it:
 * if the freshly parsed body is longer, the stored one came from a less complete
 * source. It can only ever replace a body with more content, and it converges —
 * once replaced, both sides are parsed the same way and compare equal.
 */

/** The real numbers, kept as literals so the test states its own evidence. */
const SUMMARY_LEN = 359;
const ARTICLE_LEN = 12798;

function rssPost(content: string): Post {
  return {
    id: 'rss_1',
    creatorId: 'c1',
    channelId: 'rss:daily',
    platform: 'rss',
    title: '2026-09-10',
    content,
    mediaList: [],
    originalUrl: 'https://daily.juya.uk/2026/09/10',
    publishedAt: 1,
    fetchedAt: 1,
    isRead: 0,
  };
}

/**
 * The same repair mechanism serves Twitter's media-link bodies.
 *
 * Observed: a force refresh left `https://t.co/z0PRVzIXfJ` on a card even after
 * the adapter was fixed. The sync logged「新增 0 条」— nothing was written,
 * because a normal sync never rewrites existing rows and the stored row still
 * held the old text. Caption-less tweets stored the media link as their body, so
 * the repair has to reach the rows already in the database.
 */
describe('isRssBodySuperseded', () => {
  it('replaces a summary with the full article (real measurements)', () => {
    const stored = rssPost('概览 '.repeat(SUMMARY_LEN / 3));
    const fresh = rssPost('正文 '.repeat(ARTICLE_LEN / 3));

    expect(isRssBodySuperseded(stored, fresh)).toBe(true);
  });

  it('converges: two bodies parsed the same way are equal, so it stops matching', () => {
    // After the first repair both sides come from <content:encoded>. If this rule
    // matched again, every sync would rewrite the whole page forever.
    const same = rssPost('正文 '.repeat(1000));
    expect(isRssBodySuperseded(same, rssPost('正文 '.repeat(1000)))).toBe(false);
  });

  it('never shortens a row', () => {
    // A feed that shortens its own text must not cost the user content.
    const stored = rssPost('长'.repeat(5000));
    const fresh = rssPost('短'.repeat(100));
    expect(isRssBodySuperseded(stored, fresh)).toBe(false);
  });

  it('may fill an empty stored body, never shorten a non-empty one', () => {
    // The invariant that matters is "content is never lost". Filling an empty
    // body with the freshly parsed text satisfies it; replacing longer text with
    // shorter would not, and is rejected below.
    expect(isRssBodySuperseded(rssPost(''), rssPost('正文'))).toBe(true);
    expect(isRssBodySuperseded(rssPost('正文'), rssPost(''))).toBe(false);
  });

  it('leaves a normal incremental row alone when the body is unchanged', () => {
    // The day-to-day case: same item, same text, nothing to do.
    const body = 'AI 早报 '.repeat(200);
    expect(isRssBodySuperseded(rssPost(body), rssPost(body))).toBe(false);
  });
});

describe('shouldRepairStoredContent', () => {
  function post(over: Partial<Post>): Post {
    return {
      id: 'twitter_1',
      creatorId: 'c1',
      channelId: 'twitter:a',
      platform: 'twitter',
      title: 'https://t.co/z0PRVzIXfJ',
      content: 'https://t.co/z0PRVzIXfJ',
      mediaList: [],
      originalUrl: 'https://x.com/a/status/1',
      publishedAt: 1,
      fetchedAt: 1,
      isRead: 0,
      ...over,
    };
  }

  it('repairs a stored body that is only a media link', () => {
    const stored = post({});
    const fresh = post({ title: '', content: '' });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(true);
  });

  it('repairs when the fresh text is a real caption', () => {
    const stored = post({});
    const fresh = post({ title: '强强又击击', content: '强强又击击' });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(true);
  });

  it('leaves a stored caption alone', () => {
    const stored = post({ title: '强强又击击', content: '强强又击击' });
    const fresh = post({ title: '强强又击击', content: '强强又击击' });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(false);
  });

  it('leaves a stored body that merely contains a link', () => {
    // Only a body that is *nothing but* the link is the artefact.
    const stored = post({ content: '看看这个 https://t.co/z0PRVzIXfJ' });
    const fresh = post({ content: '看看这个 https://t.co/z0PRVzIXfJ' });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(false);
  });

  it('does not apply the Twitter rule to other platforms', () => {
    // A bilibili post whose body happens to be a link is not this bug.
    const stored = post({ platform: 'bilibili', content: 'https://t.co/abc1234567' });
    const fresh = post({ platform: 'bilibili', content: 'https://t.co/abc1234567' });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(false);
  });

  it('still applies the RSS rule for a rss-vs-rss comparison', () => {
    const stored = post({ platform: 'rss', content: '摘要 '.repeat(120) });
    const fresh = post({ platform: 'rss', content: '全文 '.repeat(4000) });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(true);
  });

  it('routes the RSS rule through platform equality too', () => {
    // Same lengths, different platform: the platform guard has to win.
    const stored = post({ platform: 'rss', content: '短' });
    const fresh = post({ platform: 'twitter', content: '更长的正文' });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(false);
  });

  it('refuses to compare rows from different platforms', () => {
    const stored = post({ platform: 'rss', content: '短' });
    const fresh = post({ platform: 'twitter', content: '很长的正文'.repeat(50) });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(false);
  });
});
