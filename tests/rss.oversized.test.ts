// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The user's real feed, end to end, at the size that broke it.
 *
 * `tests/fixtures/rss/` already holds a captured `summary-vs-full.xml`. This is
 * the same source at its REAL size (268 021 characters, 10 items) because the
 * defect being pinned is purely about size: the old transport ceiling was
 * 250 000, so the document was severed mid-`<img>`, the closing tags never
 * arrived, and the adapter reported 「不是有效 XML」 — our own cut blamed on the
 * publisher.
 *
 * A synthetic body would not have caught it: the failure needed a real document
 * bigger than the ceiling with the cut landing inside markup.
 */
const FEED = readFileSync(
  path.join(import.meta.dirname, 'fixtures/rss/oversized-real-feed.xml'),
  'utf-8',
);

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

describe('rssAdapter against the real oversized feed', () => {
  it('is actually bigger than the ceiling that used to cut it', () => {
    // If this ever stops being true the test below stops testing anything —
    // so it fails loudly rather than passing vacuously.
    expect(FEED.length).toBeGreaterThan(250_000);
  });

  it('parses the whole document when the transport delivers it', async () => {
    vi.resetModules();
    vi.doMock('../src/infrastructure/chrome/http', () => ({
      bgFetch: async () => ({ ok: true, status: 200, data: FEED, truncated: false }),
    }));
    const { rssAdapter } = await import('../src/adapters/rss');
    const res = await rssAdapter.fetchLatest(channel as never, 10);

    expect(res.error).toBeUndefined();
    expect(res.posts.length).toBeGreaterThan(0);
    // The last item is only reachable if the tail of the document survived —
    // which is exactly what the old ceiling destroyed.
    expect(res.posts.some((p) => p.publishedAt > 0)).toBe(true);
  });

  it('never reports the source as malformed when the cut was ours', async () => {
    // Simulate the old behaviour at the transport layer: sever the document and
    // flag it. The adapter must name the cut, not the publisher.
    vi.resetModules();
    vi.doMock('../src/infrastructure/chrome/http', () => ({
      bgFetch: async () => ({ ok: true, status: 200, data: FEED.slice(0, 250_000), truncated: true }),
    }));
    const { rssAdapter } = await import('../src/adapters/rss');
    const res = await rssAdapter.fetchLatest(channel as never, 10);

    expect(res.error?.code).toBe('parse');
    expect(res.error?.message).toContain('截断');
    expect(res.error?.message).not.toContain('不是有效 XML');
  });
});
