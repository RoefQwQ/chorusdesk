import { describe, expect, it } from 'vitest';
import { stripAppendedLinks, twitterAdapter } from '../src/adapters/twitter';
import type { Channel } from '../src/types';

/**
 * Regression test for the silent-empty Twitter timeline.
 *
 * Observed in the 2026-09 Developer Log panel: four Twitter channels each
 * reported「同步完成 0 条，hasMore=false」with no error, while every other
 * platform reported either a filtered page or a genuine zero. `hasMore=false`
 * means the parser never even found a bottom cursor — i.e. the GraphQL payload
 * carried no tweet entries at all — and yet it was reported as a *successful*
 * sync. A silent success like that hides a broken acquisition path
 * indefinitely, which is precisely what AGENTS rule 10 forbids.
 *
 * The distinction the parser must make:
 *   - payload has tweet entries, but they are all retweets (onlyOriginal) →
 *     legitimate empty result, still a success;
 *   - payload has no tweet entries at all → the response is not the shape the
 *     parser reads → an error.
 */

const channel: Channel = {
  id: 'twitter:artist',
  creatorId: 'creator_1',
  platform: 'twitter',
  accountId: 'artist',
  displayName: 'artist',
  status: 'idle',
  profileUrl: 'https://x.com/artist',
};

const BOTTOM_CURSOR = 'DAABCgABGcURSOR';

/**
 * A live `UserTweets` entry: `itemContent.tweet_results.result`.
 *
 * An earlier version of this fixture nested it one level deeper
 * (`tweet_results.tweet_results.result`) to match what the parser happened to
 * read — which is exactly why the "one level too deep" lookup shipped green
 * while every Twitter channel silently produced zero posts. The fixture now
 * mirrors the real payload; `legacyNesting` covers the older variant the parser
 * also accepts.
 */
function tweetEntry(
  id: string,
  opts: { retweet?: boolean; legacyNesting?: boolean; fullText?: string; withAuthorUrl?: boolean } = {},
) {
  const legacy: Record<string, unknown> = {
    id_str: id,
    full_text: opts.fullText ?? `tweet ${id}`,
    created_at: 'Wed Sep 10 10:00:00 +0000 2026',
  };
  if (opts.withAuthorUrl) {
    // An author-typed link appears in `entities.urls` — the signal that keeps it
    // from being mistaken for X's appended media link.
    legacy.entities = { urls: [{ url: 'https://t.co/abc1234567', expanded_url: 'https://example.com/a' }] };
  }
  if (opts.retweet) {
    // `retweeted_status_result` lives inside `legacy`, which is where the
    // parser reads `isRetweet` from.
    legacy.retweeted_status_result = {
      result: {
        legacy: { full_text: 'original', id_str: `${id}_rt` },
        core: { user_results: { result: { legacy: { name: 'Original', screen_name: 'orig' } } } },
      },
    };
  }
  const result: Record<string, unknown> = {
    __typename: 'Tweet',
    rest_id: id,
    legacy,
    core: {
      user_results: {
        result: {
          legacy: {
            name: 'Artist',
            screen_name: 'artist',
            profile_image_url_https: 'https://pbs.twimg.com/a_normal.jpg',
          },
        },
      },
    },
  };
  return {
    entryId: `tweet-${id}`,
    content: {
      itemContent: {
        __typename: 'TimelineTweet',
        itemType: 'TimelineTweet',
        tweetDisplayType: 'Tweet',
        tweet_results: opts.legacyNesting ? { tweet_results: { result } } : { result },
      },
    },
  };
}

/**
 * A `TweetWithVisibilityResults` entry: the tweet itself lives under `tweet`,
 * so both `legacy` and `core` are one level deeper than usual.
 */
function visibilityLimitedEntry(id: string) {
  const inner = {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      full_text: `limited ${id}`,
      created_at: 'Wed Sep 10 09:00:00 +0000 2026',
    },
    core: {
      user_results: {
        result: {
          legacy: {
            name: 'Limited Author',
            screen_name: 'limited',
            profile_image_url_https: 'https://pbs.twimg.com/limited_normal.jpg',
          },
        },
      },
    },
  };
  return {
    entryId: `tweet-${id}`,
    content: {
      itemContent: {
        __typename: 'TimelineTweet',
        tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: inner } },
      },
    },
  };
}

/**
 * A long-form (note) tweet: `legacy.full_text` carries only the trailing link
 * while the caption sits under `note_tweet`. `where` selects which nesting the
 * response uses, because X has shipped both.
 */
function noteTweetEntry(id: string, body: string, where: 'result' | 'legacy') {
  const entry = tweetEntry(id, { fullText: `https://t.co/${id}` });
  const noteTweet = { note_tweet_results: { result: { text: body } } };
  const result = entry.content.itemContent.tweet_results.result as Record<string, unknown>;
  if (where === 'result') {
    result.note_tweet = noteTweet;
  } else {
    (result.legacy as Record<string, unknown>).note_tweet = noteTweet;
  }
  return entry;
}

/**
 * A tweet with an image, in the shape X actually returns.
 *
 * The media entity carries a `url` field — the `t.co` link X appends to
 * `full_text` — and this fixture used to omit it, which is why nothing caught
 * the appended link leaking into captions: the entity value the whole fix keys
 * on was simply absent from the fixture.
 *
 * `rangeFull` reproduces the shape that leaked: `display_text_range` spanning the
 * whole string, including the appended link. It only ever trims *leading*
 * @mentions, so this is what a real media tweet looks like — the earlier
 * assumption that the range excluded the media link was never measured, and a
 * fixture written to match it is what let the bug ship green.
 */
function mediaOnlyEntry(
  id: string,
  opts: { text?: string; omitRange?: boolean; rangeFull?: boolean; authorUrl?: boolean; quoted?: boolean } = {},
) {
  const caption = opts.text ?? '';
  const mediaLink = 'https://t.co/abc1234567';
  const fullText = caption ? `${caption} ${mediaLink}` : mediaLink;
  const media = {
    type: 'photo',
    media_url_https: `https://pbs.twimg.com/${id}.jpg`,
    // The appended link, as the payload names it.
    url: mediaLink,
    expanded_url: `https://x.com/artist/status/${id}/photo/1`,
  };
  const legacy: Record<string, unknown> = {
    id_str: id,
    full_text: fullText,
    created_at: 'Wed Sep 10 10:00:00 +0000 2026',
    // Author-typed URLs are listed here; X's appended media link is not.
    entities: {
      media: [media],
      urls: opts.authorUrl
        ? [{ url: 'https://t.co/author01', expanded_url: 'https://example.com/a' }]
        : [],
    },
    extended_entities: { media: [media] },
  };
  if (opts.quoted) {
    legacy.quoted_status_permalink = {
      url: 'https://t.co/quoted01',
      expanded: 'https://x.com/other/status/99',
    };
    legacy.full_text = `${fullText} https://t.co/quoted01`;
  }
  // The range covers the caption only; [0,0] when there is none. Some payloads
  // omit it entirely, and real media payloads span the whole string.
  if (!opts.omitRange) {
    legacy.display_text_range = opts.rangeFull
      ? [0, (legacy.full_text as string).length]
      : [0, caption.length];
  }
  const result: Record<string, unknown> = {
    __typename: 'Tweet',
    rest_id: id,
    legacy,
    core: {
      user_results: {
        result: { legacy: { name: 'Artist', screen_name: 'artist' } },
      },
    },
  };
  return {
    entryId: `tweet-${id}`,
    content: { itemContent: { tweet_results: { result } } },
  };
}

/** A GraphQL payload in the shape `UserTweets` returns. */
function payload(entries: unknown[], includeCursor = true) {
  const all = includeCursor
    ? [...entries, { entryId: `cursor-bottom-${BOTTOM_CURSOR}`, content: { cursorType: 'Bottom', value: BOTTOM_CURSOR } }]
    : entries;
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [{ type: 'TimelineAddEntries', entries: all }],
            },
          },
        },
      },
    },
  };
}

function parse(tweetData: unknown, onlyOriginal?: boolean) {
  return twitterAdapter.parseGraphQLResult!(
    channel,
    tweetData,
    undefined,
    10,
    onlyOriginal,
    undefined,
  );
}

describe('twitter parseGraphQLResult', () => {
  it('parses the live payload shape (itemContent.tweet_results.result)', () => {
    // Regression for the shipped bug: the lookup read
    // `tweet_results.tweet_results.result`, one level too deep, so every entry
    // produced `{}` and every Twitter channel reported a successful sync with
    // zero posts — for months, on every account, with no error anywhere.
    const res = parse(payload([tweetEntry('1'), tweetEntry('2')]));

    expect(res.error).toBeUndefined();
    expect(res.posts).toHaveLength(2);
    expect(res.posts[0].id).toBe('twitter_1');
    expect(res.posts[0].originalUrl).toBe('https://x.com/artist/status/1');
    expect(res.totalFetched).toBe(2);
  });

  it('recovers author name and avatar from a visibility-limited tweet', () => {
    // These carry `core` one level down (under `tweet`). The old `||` fallback
    // never ran, because `asRecord()` returns a truthy `{}` on a miss, so the
    // author came back empty for every such tweet.
    //
    // Tweet-level author meta only fills in when the channel has no better
    // source (a known displayName or avatar wins), so the channel here carries
    // neither — which is exactly the post-follow state.
    const bare: Channel = { ...channel, displayName: '', avatarUrl: undefined };
    const res = twitterAdapter.parseGraphQLResult!(
      bare,
      payload([visibilityLimitedEntry('limited_1')]),
      undefined,
      10,
      undefined,
      undefined,
    );

    expect(res.posts).toHaveLength(1);
    expect(res.authorMeta?.name).toBe('Limited Author');
    expect(res.authorMeta?.avatar).toContain('pbs.twimg.com');
  });

  it('uses the long-form body from note_tweet at either nesting level', () => {
    // A note tweet's `legacy.full_text` holds only the trailing link; the caption
    // lives in `note_tweet`. Reading it from the wrong level silently produces a
    // card whose entire body is a t.co URL — which is what the UI showed.
    const longBody = '#崩坏星穹铁道 '.repeat(30).trim();

    const atResult = parse(payload([noteTweetEntry('n1', longBody, 'result')]));
    expect(atResult.posts[0].content).toBe(longBody);

    const atLegacy = parse(payload([noteTweetEntry('n2', longBody, 'legacy')]));
    expect(atLegacy.posts[0].content).toBe(longBody);
  });

  it('does not print a bare link as the card title', () => {
    // Link-only posts produced a card titled with the same t.co URL that the
    // body already showed. The title should identify the account instead.
    const res = parse(payload([tweetEntry('1', { fullText: 'https://t.co/abc123' })]));

    expect(res.posts[0].content).toBe('https://t.co/abc123');
    expect(res.posts[0].title).toBe('@artist 的推文');
  });

  it('still uses real text as the title', () => {
    const res = parse(payload([tweetEntry('1', { fullText: '强强又击击' })]));
    expect(res.posts[0].title).toBe('强强又击击');
  });

  it('still accepts the older doubly-nested payload', () => {
    const res = parse(payload([tweetEntry('1', { legacyNesting: true })]));

    expect(res.error).toBeUndefined();
    expect(res.posts).toHaveLength(1);
    expect(res.totalFetched).toBe(1);
  });

  it('treats a media-only tweet as having no body at all', () => {
    // The measured payload: `display_text_range=0-0`, `full_text` length 23
    // (exactly the media's t.co link), `entities.urls=0`. The author wrote
    // nothing — rendering `full_text` is what made image-only posts show a bare
    // t.co URL as their body.
    const res = parse(payload([mediaOnlyEntry('m1')]));

    expect(res.posts).toHaveLength(1);
    expect(res.posts[0].content).toBe('');
    // And no synthetic heading over an image.
    expect(res.posts[0].title).toBe('');
    expect(res.posts[0].mediaList).toHaveLength(1);
  });

  it('strips the media link X appends to a caption', () => {
    // A tweet with text AND an image: `full_text` carries the text plus the
    // image's t.co link, while `display_text_range` covers only the text.
    const res = parse(payload([mediaOnlyEntry('m2', { text: '强强又击击', })]))

    ;
    expect(res.posts[0].content).toBe('强强又击击');
  });

  it('falls back to the raw text when the range is absent', () => {
    // Older or alternate payloads omit `display_text_range`; behaviour must not
    // regress to empty posts.
    const res = parse(payload([tweetEntry('1', { fullText: '普通推文内容' })]));
    expect(res.posts[0].content).toBe('普通推文内容');
  });

  it('blanks a bare media link even when display_text_range is absent', () => {
    // The hole that let a t.co URL survive a force refresh: `display_text_range`
    // is missing on some payloads, so the range-based trim falls back to the raw
    // text — media link and all. `entities.urls` being empty proves the link is
    // X's own, not something the author typed.
    const res = parse(payload([mediaOnlyEntry('m3', { omitRange: true })]));

    expect(res.posts).toHaveLength(1);
    expect(res.posts[0].content).toBe('');
    expect(res.posts[0].title).toBe('');
  });

  it('keeps a link the author actually typed (no media involved)', () => {
    // A link-only tweet with NO media: the link is the author's content, and
    // `entities.urls` lists it. It must not be blanked.
    const res = parse(payload([tweetEntry('1', { fullText: 'https://t.co/abc1234567', withAuthorUrl: true })]));
    expect(res.posts[0].content).toBe('https://t.co/abc1234567');
  });

  it('ignores an empty body rather than treating it as a link', () => {
    const res = parse(payload([tweetEntry('1', { fullText: '' })]));
    expect(res.posts[0].content).toBe('');
  });

  it('still parses a normal timeline and reports the raw entry count', () => {
    const res = parse(payload([tweetEntry('1'), tweetEntry('2')]));

    expect(res.error).toBeUndefined();
    expect(res.posts).toHaveLength(2);
    // Raw count, before any filtering — this is what the sync log prints.
    expect(res.totalFetched).toBe(2);
  });

  it('treats a timeline of nothing but retweets as a legitimate empty result', () => {
    const res = parse(payload([tweetEntry('1', { retweet: true }), tweetEntry('2', { retweet: true })]), true);

    // The page did return tweets; onlyOriginal is what removed them. Not an error.
    expect(res.error).toBeUndefined();
    expect(res.posts).toEqual([]);
    expect(res.totalFetched).toBe(2);
  });

  it('reports an error when the payload carries no tweet entries at all', () => {
    // The observed failure: instructions present, cursor absent, zero tweets.
    const res = parse(payload([], false));

    expect(res.posts).toEqual([]);
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe('parse');
    // The message must tell the user what to check, not just that it failed.
    expect(res.error!.message).toContain('未返回任何推文条目');
  });

  it('reports an error for a payload missing the timeline entirely', () => {
    const res = parse({ data: { user: { result: {} } } });

    expect(res.posts).toEqual([]);
    expect(res.error?.code).toBe('parse');
  });

  it('distinguishes "all retweets" from "shapes we could not read"', () => {
    // Both produce 0 posts, and the whole point of `totalFetched` plus the
    // logged drop-reason is that they must not look alike: the first is a
    // legitimate empty result, the second is a broken parser.
    //
    // All-retweets: entries parse fine, the filter removes them.
    const allRetweets = parse(
      payload([tweetEntry('1', { retweet: true }), tweetEntry('2', { retweet: true })]),
      true,
    );
    expect(allRetweets.error).toBeUndefined();
    expect(allRetweets.totalFetched).toBe(2);

    // Unreadable bodies: entries exist but carry no `legacy` body to read, so
    // nothing can be extracted even with the filter off.
    const noBody = {
      data: {
        user: {
          result: {
            timeline_v2: {
              timeline: {
                instructions: [{
                  type: 'TimelineAddEntries',
                  entries: [
                    { entryId: 'tweet-1', content: { itemContent: { tweet_results: { tweet_results: { result: { __typename: 'Tweet', rest_id: '1' } } } } } },
                    { entryId: 'tweet-2', content: { itemContent: { tweet_results: { tweet_results: { result: { __typename: 'Tweet', rest_id: '2' } } } } } },
                  ],
                }],
              },
            },
          },
        },
      },
    };
    const unreadable = parse(noBody);
    expect(unreadable.posts).toEqual([]);
    // Entries were seen, so this is NOT the "no entries at all" error path…
    expect(unreadable.totalFetched).toBe(2);
    // …but it also must not report posts that were never extracted.
    expect(unreadable.posts).toHaveLength(0);
  });
});

/**
 * The link X appends to the end of a tweet's text.
 *
 * Observed by the user: a caption rendered as `正文… https://t.co/xxxx`, with the
 * shortened link glued to the end of the body (and, for a short caption, to the
 * end of the bolded title line). It appeared because the parser trusted
 * `display_text_range` to exclude it — an assumption that had never been
 * measured against a real payload, and which the fixture then encoded as
 * expected behaviour by setting the range to end at the caption.
 *
 * X's own clients do not rely on the range: they remove each media entity's
 * `url` from the text. That is what this does, which is why the fix works
 * whether or not the range happens to exclude the link.
 */
describe('twitter appended links', () => {
  it('removes the media link when display_text_range spans the whole text', () => {
    // The real shape, and the one that leaked: the range is the entire string.
    const res = parse(payload([mediaOnlyEntry('t1', { text: '今天画了新的图', rangeFull: true })]));

    expect(res.posts[0].content).toBe('今天画了新的图');
  });

  it('removes the link when display_text_range is missing entirely', () => {
    // The other real variant: no range at all, so the raw text comes through and
    // the appended link is only findable from the entities.
    const res = parse(payload([mediaOnlyEntry('t0', { text: '今天画了新的图', omitRange: true })]));

    expect(res.posts[0].content).toBe('今天画了新的图');
  });

  it('does not put the link in the title', () => {
    // The title is the body's first line, so a leaked link turned a short
    // caption into `caption https://t.co/…` in bold above the same caption.
    const res = parse(payload([mediaOnlyEntry('t2', { text: '今天画了新的图', rangeFull: true })]));

    expect(res.posts[0].title).toBe('今天画了新的图');
  });

  it('removes a link X appended after several lines of caption', () => {
    const res = parse(payload([mediaOnlyEntry('t3', { text: '第一行\n第二行', rangeFull: true })]));

    expect(res.posts[0].content).toBe('第一行\n第二行');
  });

  it('removes the quoted tweet\'s appended link as well', () => {
    // A quote gets the same treatment from X, and it is equally not the
    // author's text.
    const res = parse(payload([mediaOnlyEntry('t4', { text: '看看这个', rangeFull: true, quoted: true })]));

    expect(res.posts[0].content).toBe('看看这个');
    expect(res.posts[0].content).not.toContain('t.co');
  });

  it('keeps a link the author typed, even alongside media', () => {
    // The author's link lives in `entities.urls`, never in a media entity, so it
    // is not in the appended set. Removing it would delete content they wrote.
    const res = parse(payload([mediaOnlyEntry('t5', { text: '参考 https://t.co/author01', rangeFull: true, authorUrl: true })]));

    expect(res.posts[0].content).toContain('https://t.co/author01');
    expect(res.posts[0].content).not.toContain('https://t.co/abc1234567');
  });

  it('leaves a body with no appended link untouched', () => {
    const res = parse(payload([tweetEntry('1', { fullText: '普通的推文，没有链接' })]));

    expect(res.posts[0].content).toBe('普通的推文，没有链接');
  });

  it('still blanks an image-only tweet whose range spans the link', () => {
    // No caption at all: the "range covers everything" case for a media-only
    // tweet, which must end up empty rather than showing the link as the body.
    const res = parse(payload([mediaOnlyEntry('t6', { rangeFull: true })]));

    expect(res.posts[0].content).toBe('');
    expect(res.posts[0].title).toBe('');
  });
});

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
