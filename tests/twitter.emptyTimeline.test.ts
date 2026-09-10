import { describe, expect, it } from 'vitest';
import { twitterAdapter } from '../src/adapters/twitter';
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
 * An image-only tweet, exactly as measured in the 2026-09 logs:
 * `full_text` is just the media's t.co link (23 chars) and `display_text_range`
 * is `[0, 0]` — X's way of saying "the author wrote no text".
 */
function mediaOnlyEntry(
  id: string,
  opts: { text?: string; omitRange?: boolean } = {},
) {
  const caption = opts.text ?? '';
  const mediaLink = 'https://t.co/abc1234567';
  const legacy: Record<string, unknown> = {
    id_str: id,
    full_text: caption ? `${caption} ${mediaLink}` : mediaLink,
    created_at: 'Wed Sep 10 10:00:00 +0000 2026',
    // Author-typed URLs are listed here; X's appended media link is not.
    entities: { media: [{ type: 'photo', media_url_https: `https://pbs.twimg.com/${id}.jpg` }], urls: [] },
    extended_entities: { media: [{ type: 'photo', media_url_https: `https://pbs.twimg.com/${id}.jpg` }] },
  };
  // The range covers the caption only; [0,0] when there is none. Some payloads
  // omit it entirely — the case that used to leak the media link through.
  if (!opts.omitRange) legacy.display_text_range = [0, caption.length];
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
