import { describe, expect, it } from 'vitest';
import { isLegacyTruncatedRssContent, shouldRepairStoredContent } from '../src/sync/channelSync';
import type { Post } from '../src/types';

/**
 * Auto-repair of RSS bodies truncated by the removed 350-character cap.
 *
 * The old adapter stored `cleanText.slice(0, 350) + '...'`. Users who had already
 * synced those items keep the truncated text — a normal sync never rewrites
 * existing rows, so the fix could not reach them without the user discovering
 * `Shift + click`. This predicate is the narrow rule that lets the incremental
 * path repair exactly those rows and nothing else.
 *
 * The rule must be provably safe: it may only ever replace a truncated body with
 * a longer one, never shorten or overwrite a healthy body.
 */

/** A body exactly as the old cap produced it. */
function legacyBody(): string {
  return 'x'.repeat(350) + '...';
}

describe('isLegacyTruncatedRssContent', () => {
  it('recognizes the old cap\'s exact fingerprint', () => {
    // 350 stored characters plus the literal '...' the old code appended.
    expect(isLegacyTruncatedRssContent(legacyBody(), 'y'.repeat(1000))).toBe(true);
  });

  it('does not touch a body of the right length that was not cut', () => {
    // 353 characters is only the fingerprint when it ENDS with the marker.
    const notTruncated = 'z'.repeat(353);
    expect(isLegacyTruncatedRssContent(notTruncated, 'y'.repeat(1000))).toBe(false);
  });

  it('does not touch a body ending in an ellipsis of a different length', () => {
    // The new implementation caps at 4000 with a single '…', so a long body that
    // merely *ends* with '...' is not the legacy artefact — requiring exactly 353
    // characters is what keeps the rule from overwriting healthy rows that happen
    // to end that way.
    expect(isLegacyTruncatedRssContent('y'.repeat(600) + '...', 'z'.repeat(5000))).toBe(false);
    expect(isLegacyTruncatedRssContent('y'.repeat(100) + '...', 'z'.repeat(5000))).toBe(false);
    // And the new style's own marker is not the legacy one.
    expect(isLegacyTruncatedRssContent('y'.repeat(4000) + '…', 'z'.repeat(5000))).toBe(false);
  });

  it('never shortens a row: a fresh body that is not longer is ignored', () => {
    const stored = legacyBody();
    expect(isLegacyTruncatedRssContent(stored, stored)).toBe(false);
    expect(isLegacyTruncatedRssContent(stored, 'short')).toBe(false);
  });

  it('ignores a healthy long body', () => {
    expect(isLegacyTruncatedRssContent('z'.repeat(1000), 'y'.repeat(1200))).toBe(false);
  });

  it('ignores an empty or missing stored body', () => {
    expect(isLegacyTruncatedRssContent('', 'y'.repeat(1000))).toBe(false);
  });
});

/**
 * The same repair mechanism serves Twitter's media-link bodies.
 *
 * Observed: a force refresh left `https://t.co/z0PRVzIXfJ` on a card even after
 * the adapter was fixed. The sync logged「新增 0 条」— nothing was written,
 * because a normal sync never rewrites existing rows and the stored row still
 * held the old text. Caption-less tweets stored the media link as their body, so
 * the repair has to reach the rows already in the database.
 */
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

  it('still applies the RSS rule', () => {
    const stored = post({ platform: 'rss', content: 'x'.repeat(350) + '...' });
    const fresh = post({ platform: 'rss', content: 'y'.repeat(1000) });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(true);
  });

  it('refuses to compare rows from different platforms', () => {
    const stored = post({ platform: 'rss', content: 'x'.repeat(350) + '...' });
    const fresh = post({ platform: 'twitter', content: 'y'.repeat(1000) });

    expect(shouldRepairStoredContent(stored, fresh)).toBe(false);
  });
});
