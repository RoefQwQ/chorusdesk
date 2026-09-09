import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { normalizeSnapshot } from '../src/adapters/douyin/contract';
import { buildDouyinPosts } from '../src/adapters/douyin';
import type { Channel } from '../src/types';

/**
 * Integration check over a snapshot captured by the SHIPPED collector running in
 * a real Chrome MV3 profile against a live Douyin creator page (2026-09).
 *
 * The capture is not committed (it embeds a real account's signed CDN URLs), so
 * this suite skips when the artifact is absent — it documents and re-verifies the
 * end-to-end shape on a machine that has one, without making CI depend on
 * douyin.com being reachable.
 */
const CAPTURE = process.env.DOUYIN_E2E_SNAPSHOT
  ?? 'C:/Users/27033/.claude/jobs/102808d0/tmp/e2e_snapshot.json';

const channel: Channel = {
  id: 'douyin:e2e',
  creatorId: 'creator_e2e',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAAe2e',
  displayName: '',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAe2e',
};

const hasCapture = existsSync(CAPTURE);

describe.skipIf(!hasCapture)('douyin live capture → Post pipeline', () => {
  const raw = hasCapture ? JSON.parse(readFileSync(CAPTURE, 'utf8')) : null;

  it('normalizes every work the real page yielded', () => {
    const snapshot = normalizeSnapshot(raw)!;
    expect(snapshot).not.toBeNull();
    expect(snapshot.items.length).toBeGreaterThan(0);
    // Nothing may survive without a usable id and a finite, plausible timestamp.
    for (const item of snapshot.items) {
      expect(item.awemeId).toMatch(/^\d{15,25}$/);
      expect(Number.isFinite(item.publishedAt)).toBe(true);
      expect(item.publishedAt).toBeGreaterThan(1_451_606_400_000);
      expect(item.pageUrl.startsWith('https://www.douyin.com/')).toBe(true);
    }
  });

  it('recovers the author identity from the live page', () => {
    const snapshot = normalizeSnapshot(raw)!;
    expect(snapshot.authorName.length).toBeGreaterThan(0);
    // The avatar must have cleared the CDN allowlist to be usable at all.
    if (raw.authorAvatar) expect(snapshot.authorAvatar).toContain('douyinpic.com');
  });

  it('strips the author prefix the real cover alt carries', () => {
    const snapshot = normalizeSnapshot(raw)!;
    const name = snapshot.authorName;
    for (const item of snapshot.items) {
      expect(item.description.startsWith(`${name}：`)).toBe(false);
    }
  });

  it('builds stable, unique Posts and never links to a signed URL', () => {
    const snapshot = normalizeSnapshot(raw)!;
    const posts = buildDouyinPosts(channel, snapshot, 50);
    expect(posts.length).toBe(snapshot.items.length);

    const ids = posts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const post of posts) {
      expect(post.id).toMatch(/^douyin_\d{15,25}$/);
      expect(post.originalUrl).not.toContain('x-signature');
      expect(post.isRead).toBe(0);
      expect(post.publishedAt).toBeGreaterThan(0);
    }
  });

  it('a second sync at the new watermark discovers nothing (no duplicates)', () => {
    const snapshot = normalizeSnapshot(raw)!;
    const first = buildDouyinPosts(channel, snapshot, 50);
    const watermark = Math.max(...first.map((p) => p.publishedAt));
    expect(buildDouyinPosts(channel, snapshot, 50, { sinceTimestamp: watermark })).toEqual([]);
  });

  it('only the newer work returns after the watermark is rolled back one item', () => {
    const snapshot = normalizeSnapshot(raw)!;
    const sorted = [...snapshot.items].sort((a, b) => b.publishedAt - a.publishedAt);
    const posts = buildDouyinPosts(channel, snapshot, 50, { sinceTimestamp: sorted[1].publishedAt });
    expect(posts.map((p) => p.id)).toEqual([`douyin_${sorted[0].awemeId}`]);
  });
});
