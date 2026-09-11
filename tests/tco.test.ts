import { describe, expect, it } from 'vitest';
import { isTcoUrl, stripAppendedLinks, stripTrailingTcoLink } from '../src/utils/tco';

/**
 * `t.co` handling, tested where it lives.
 *
 * These cases used to sit inside `tests/twitter.emptyTimeline.test.ts`, which made
 * them invisible to anyone asking the obvious question — "is `src/utils/tco.ts`
 * tested?" — and that is exactly what the maintainability audit recorded as a gap.
 * Nothing about them was wrong; their address was. Two callers now depend on this
 * module and only one of them is the Twitter adapter: the Dexie v5 migration in
 * `database.ts` strips stored bodies with the text-only rule, with no entity list
 * available. Both rules are therefore pinned here, on their own terms.
 *
 * The two rules differ on purpose and the difference is the point:
 *  - `stripAppendedLinks` is entity-driven. The payload names what X appended, so
 *    an author's link — which lives in `entities.urls`, never in a media entity —
 *    is absent from the candidate set and survives.
 *  - `stripTrailingTcoLink` has only the text. It must therefore be narrower:
 *    trailing links only. A link mid-caption is far more likely to be the author's,
 *    and the database keeps no entity list that could tell the difference.
 */

describe('stripAppendedLinks', () => {
  const MEDIA = 'https://t.co/abc1234567';

  it('removes the link and the gap it leaves', () => {
    expect(stripAppendedLinks(`正文 ${MEDIA}`, [MEDIA])).toBe('正文');
  });

  it('collapses the double space a mid-body link leaves behind', () => {
    expect(stripAppendedLinks(`前 ${MEDIA} 后`, [MEDIA])).toBe('前 后');
  });

  it('removes a link alone on its own trailing line', () => {
    expect(stripAppendedLinks(`第一行\n第二行\n${MEDIA}`, [MEDIA])).toBe('第一行\n第二行');
  });

  it('keeps line breaks that were not around a link', () => {
    expect(stripAppendedLinks('第一行\n第二行', [MEDIA])).toBe('第一行\n第二行');
  });

  it('handles several appended links', () => {
    const second = 'https://t.co/def7654321';
    expect(stripAppendedLinks(`正文 ${MEDIA} ${second}`, [MEDIA, second])).toBe('正文');
  });

  it('is a no-op when nothing was appended', () => {
    expect(stripAppendedLinks('正文', [])).toBe('正文');
  });

  it('ignores anything that is not a t.co URL', () => {
    // The values come from untrusted payload JSON. A non-URL must not be able to
    // blank out text by matching a substring of it, so it is rejected outright
    // rather than used as a search string.
    expect(stripAppendedLinks('正文 https://example.com/a', ['https://example.com/a']))
      .toBe('正文 https://example.com/a');
    expect(stripAppendedLinks('abcdef', ['abc'])).toBe('abcdef');
  });

  it('ignores a non-string entry rather than throwing', () => {
    expect(stripAppendedLinks('正文', [null, undefined, 42, { url: MEDIA }])).toBe('正文');
  });
});

describe('stripTrailingTcoLink', () => {
  const LINK = 'https://t.co/abc1234567';

  it('removes a link at the very end', () => {
    expect(stripTrailingTcoLink(`正文 ${LINK}`)).toBe('正文');
  });

  it('removes a link on its own trailing line', () => {
    expect(stripTrailingTcoLink(`第一行\n第二行\n${LINK}`)).toBe('第一行\n第二行');
  });

  it('removes several trailing links', () => {
    expect(stripTrailingTcoLink(`正文 ${LINK} https://t.co/zzz9999999`)).toBe('正文');
  });

  it('leaves a link in the middle of the text alone', () => {
    // The text-only rule exists for rows with no entity data left, so it has to
    // be narrow: a link mid-caption is far more likely to be the author's.
    expect(stripTrailingTcoLink(`看看 ${LINK} 很好`)).toBe(`看看 ${LINK} 很好`);
  });

  it('leaves a non-t.co URL alone', () => {
    expect(stripTrailingTcoLink('正文 https://example.com/a')).toBe('正文 https://example.com/a');
  });

  it('is a no-op when there is no link', () => {
    expect(stripTrailingTcoLink('正文')).toBe('正文');
  });

  it('empties a body that was nothing but the link', () => {
    // A media-only tweet: the link was the entire body.
    expect(stripTrailingTcoLink(LINK)).toBe('');
  });
});

describe('isTcoUrl', () => {
  // The predicate that decides whether a value from a payload may be used as a
  // search string at all. `stripAppendedLinks` calls it on every candidate, so a
  // hole here is a hole in the stripping rule.
  it('accepts the https form X actually emits', () => {
    expect(isTcoUrl('https://t.co/abc1234567')).toBe(true);
    // X only ever emits https, so the stricter match costs nothing and rejects
    // more junk; pinned so a future loosening is a deliberate choice.
    expect(isTcoUrl('http://t.co/x')).toBe(false);
    // Whitespace around a payload value is tolerated.
    expect(isTcoUrl('  https://t.co/abc  ')).toBe(true);
  });

  it('rejects a link on any other host, including a look-alike', () => {
    expect(isTcoUrl('https://example.com/a')).toBe(false);
    expect(isTcoUrl('https://t.co.evil.example/a')).toBe(false);
    expect(isTcoUrl('https://nott.co/a')).toBe(false);
  });

  it('rejects anything that is not a string', () => {
    expect(isTcoUrl(null)).toBe(false);
    expect(isTcoUrl(undefined)).toBe(false);
    expect(isTcoUrl(42)).toBe(false);
    expect(isTcoUrl({ url: 'https://t.co/abc' })).toBe(false);
  });

  it('rejects a bare substring and a non-http scheme', () => {
    expect(isTcoUrl('abc')).toBe(false);
    expect(isTcoUrl('t.co/abc')).toBe(false);
    expect(isTcoUrl('javascript:https://t.co/a')).toBe(false);
  });
});
