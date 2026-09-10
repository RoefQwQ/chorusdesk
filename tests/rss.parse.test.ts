// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * RSS body extraction, end to end.
 *
 * The adapter read `item.querySelector('description, summary, content')`. A feed
 * that carries a truncated summary in `<description>` and the article in
 * `<content:encoded>` therefore had its post body taken from the summary — which
 * is why a reader saw an article stop mid-sentence with the feed's own ellipsis.
 *
 * The fixture is the real payload: the `<description>` is verbatim from the feed
 * (359 characters, ending in "…"), and `<content:encoded>` is a verbatim prefix
 * of the real escaped article HTML. A fixture invented to match what the parser
 * reads would have locked the bug in as expected behaviour.
 */

const FEED = readFileSync(
  path.join(import.meta.dirname, 'fixtures/rss/summary-vs-full.xml'),
  'utf-8',
);

/** Only the body of the description, for contrast with the stored article. */
const SUMMARY_TAIL = 'GLM 5.3 Flash 在 OpenCode…';
/** The feed's own `<description>` length, measured on the real payload. */
const SUMMARY_LEN = 359;

vi.mock('../src/utils/http', () => ({
  bgFetch: async () => ({ ok: true, status: 200, data: FEED }),
}));

const channel = {
  id: 'rss:juya',
  platform: 'rss' as const,
  accountId: 'https://daily.juya.uk/rss.xml',
  profileUrl: 'https://daily.juya.uk/rss.xml',
  label: 'daily.juya.uk',
  enabled: 1 as const,
  createdAt: 1,
  url: 'https://daily.juya.uk/rss.xml',
};

async function fetchFirst() {
  const { rssAdapter } = await import('../src/adapters/rss');
  const res = await rssAdapter.fetchLatest(channel as never, 10);
  if (res.error) throw new Error(`fetch failed: ${JSON.stringify(res.error)}`);
  return res.posts[0];
}

describe('rssAdapter body extraction', () => {
  it('stores the article from content:encoded, not the truncated summary', async () => {
    const post = await fetchFirst();

    // The summary is 359 characters. A body of that size means the wrong element
    // was read, however the text happens to be worded.
    expect(post.content.length).toBeGreaterThan(SUMMARY_LEN * 2);
    expect(post.content).not.toBe(SUMMARY_TAIL);
  });

  it('includes text that exists only in the full article', async () => {
    // Guards against a truncation that happens to produce a long-but-wrong body:
    // this sentence is present in <content:encoded> and nowhere else.
    const post = await fetchFirst();

    expect(post.content).toContain('SENTINEL_ARTICLE_TAIL');
  });

  it('does not end with the feed summary\'s own ellipsis', async () => {
    // The tell in the user's screenshot: the body stopped at the summary's "…".
    const post = await fetchFirst();

    expect(post.content.endsWith('…')).toBe(false);
  });

  it('strips the article markup rather than storing raw HTML', async () => {
    const post = await fetchFirst();

    expect(post.content).not.toContain('<div');
    expect(post.content).not.toContain('&lt;');
    expect(post.content).not.toContain('font-family');
  });

  it('still reads a feed that only has a description', async () => {
    // Most third-party feeds have no <content:encoded>. The fallback must survive
    // the change, or fixing this one feed breaks every other subscription.
    const summaryOnly = FEED.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, '');
    vi.doMock('../src/utils/http', () => ({
      bgFetch: async () => ({ ok: true, status: 200, data: summaryOnly }),
    }));

    vi.resetModules();
    const post = await fetchFirst();

    expect(post.content).toContain('AI 早报');
    expect(post.content.length).toBeGreaterThan(50);
  });
});
