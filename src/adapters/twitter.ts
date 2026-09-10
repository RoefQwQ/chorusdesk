import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { IS_SERVICE_WORKER } from '../utils/runtime';
import type { JsonRecord, JsonValue } from '../utils/json';
import { asRecord, firstFilled } from '../utils/json';
import { devLog } from '../utils/devLog';

/**
 * The tweet's own text, as X says it should be shown.
 *
 * `display_text_range` is the `[start, end]` slice of `full_text` that is the
 * author's text. X appends the media / quoted-tweet `t.co` URL to `full_text` but
 * excludes it from this range, and for a media-only tweet it sends `[0, 0]` —
 * the author wrote nothing, and the ~23-character `full_text` is entirely the
 * media link. Rendering `full_text` raw is why image-only posts showed a bare
 * `t.co` URL as their body (measured: `display_text_range=0-0`, `full_text` length
 * 23, `entities.urls=0`).
 *
 * Falls back to the raw text when the range is absent or malformed, so a payload
 * change degrades to the previous behaviour rather than to empty posts.
 */
export function displayableTweetText(fullText: string, range: unknown): string {
  if (!Array.isArray(range) || range.length < 2) return fullText;
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return fullText;
  if (start < 0 || end < start || end > fullText.length) return fullText;
  return fullText.slice(start, end);
}

/**
 * True when `text` is nothing but the media link X appends to a tweet.
 *
 * `display_text_range` is the precise signal, but it is absent on some payloads —
 * and the fallback then returns `full_text` verbatim, media link included, which
 * is why a bare t.co URL survived on a card even after the range-based trim.
 *
 * The two conditions make this provably the *media* link rather than something
 * the author typed: the tweet carries media (so X appended a link), and
 * `entities.urls` is empty (author-typed URLs are listed there). A tweet where
 * the author posted only a link has that link in `entities.urls`, so it is not
 * matched and its text is preserved.
 */
export function isMediaOnlyLinkText(text: string, hasMedia: boolean, authorUrlCount: number): boolean {
  if (!hasMedia || authorUrlCount > 0) return false;
  return /^https:\/\/t\.co\/\w+$/.test(text.trim());
}

/**
 * Remove the `t.co` URLs X appends to a tweet's text.
 *
 * X glues a shortened URL to the end of `full_text` for every attached medium
 * and for a quoted tweet. `display_text_range` was believed to exclude them, and
 * it does on some payloads — but not reliably, which is why a caption rendered as
 * `正文… https://t.co/xxxx` with the link stuck to the end, and why a short
 * caption's title line became the caption *plus* the link.
 *
 * X's own clients do not lean on the range for this: they take each media
 * entity's `url` and remove that exact substring. Same approach, which is why
 * this only ever removes URLs the payload itself names as appended.
 *
 * An author-typed link is **never** removed: it lives in `entities.urls`, not in
 * a media entity, so it is absent from `appendedUrls`. Dropping it would silently
 * delete something the author actually wrote.
 */
export function stripAppendedLinks(text: string, appendedUrls: readonly unknown[]): string {
  let out = text;
  for (const raw of appendedUrls) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    // Only a real t.co URL: a malformed entity value must not be able to blank
    // out arbitrary text by matching a substring of it.
    if (!/^https:\/\/t\.co\/\w+$/.test(url)) continue;
    // Removed occurrence by occurrence rather than with one `replace`, so the
    // pass cannot restart inside text it already rewrote.
    out = out.split(url).join(' ');
  }
  // A removed link leaves a gap where it stood: a stray double space when it was
  // mid-caption, a blank line when it was alone on the last one. Collapse both so
  // the body reads as the author wrote it.
  return out
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The `t.co` URLs this payload says were appended to the tweet's text.
 *
 * Read from the entities rather than pattern-matched, because that is the only
 * way to tell X's appended link apart from one the author typed. Values are
 * passed through unvalidated — `stripAppendedLinks` is the single place that
 * decides what counts as an appended link.
 */
function appendedLinkUrls(mediaItems: readonly unknown[], tweet: JsonRecord): unknown[] {
  const urls: unknown[] = [];
  for (const raw of mediaItems) {
    const url = asRecord(raw).url;
    if (typeof url === 'string' && url) urls.push(url);
  }
  // A quoted tweet is appended the same way, from its permalink entity.
  const quotedPermalink = asRecord(tweet.quoted_status_permalink).url;
  if (typeof quotedPermalink === 'string' && quotedPermalink) urls.push(quotedPermalink);
  return urls;
}

export const twitterAdapter: PlatformAdapter = {
  platform: 'twitter',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    const username = channel.accountId.replace(/^@/, '').trim();

    // The SW never receives its own runtime.sendMessage, so from the
    // background (auto-sync) the FETCH_TWITTER_TIMELINE channel is unusable.
    if (IS_SERVICE_WORKER) {
      return {
        posts: [],
        error: fetchError('unsupported', '后台自动同步暂不支持推特（需在扩展页面中同步）'),
      };
    }

    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return {
        posts: [],
        error: fetchError('unsupported', '当前运行环境不支持与扩展后台通信'),
      };
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'FETCH_TWITTER_TIMELINE',
        username,
        limit,
        onlyOriginal: Boolean(options?.onlyOriginal),
        cursor: options?.cursor || '',
      });

      if (!res) {
        return {
          posts: [],
          error: fetchError('network', '扩展后台服务未响应，请在 chrome://extensions 中重新加载插件后重试', true),
        };
      }

      if (!res.success) {
        return {
          posts: [],
          error: fetchError('network', res.error || '获取推文失败', true),
        };
      }

      if (res.tweetData) {
        const parseGraphQLResult = this.parseGraphQLResult;
        if (!parseGraphQLResult) {
          return {
            posts: [],
            error: fetchError('parse', '推特解析器不可用'),
          };
        }
        return parseGraphQLResult.call(
          this,
          channel,
          res.tweetData,
          res.userData,
          limit,
          options?.onlyOriginal,
          res.bottomCursor
        );
      }

      return {
        posts: [],
        error: fetchError('parse', '推特未返回有效数据'),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        posts: [],
        error: fetchError('network', `调用推特同步后台失败: ${message}`, true),
      };
    }
  },

  parseGraphQLResult(
    channel: Channel,
    tweetData: unknown,
    userData: unknown,
    limit: number,
    onlyOriginal?: boolean,
    bottomCursor?: string
  ): FetchResult {
    const posts: Post[] = [];
    const username = channel.accountId.replace(/^@/, '').trim();

    // Extract author profile with multiple GraphQL fallback paths
    const userRes = asRecord(asRecord(asRecord(asRecord(userData).data).user).result);
    const userLegacy = asRecord(userRes.legacy);
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    let authorName =
      str(userLegacy.name) ||
      str(userRes.name) ||
      channel.displayName ||
      `@${username}`;

    let authorAvatar =
      str(userLegacy.profile_image_url_https) ||
      str(asRecord(userRes.avatar).image_url) ||
      str(asRecord(userLegacy.avatar).image_url) ||
      str(userRes.profile_image_url_https) ||
      channel.avatarUrl ||
      '';

    // Upgrade avatar resolution to bigger/original
    if (authorAvatar.includes('_normal.')) {
      authorAvatar = authorAvatar.replace('_normal.', '_bigger.');
    } else if (authorAvatar.includes('_normal')) {
      authorAvatar = authorAvatar.replace('_normal', '_bigger');
    }

    const timelineRoot = asRecord(
      asRecord(asRecord(asRecord(asRecord(asRecord(tweetData).data).user).result).timeline_v2).timeline ||
      asRecord(asRecord(asRecord(asRecord(asRecord(tweetData).data).user).result).timeline).timeline
    );
    const rawInstructions = timelineRoot.instructions;
    const instructions: JsonValue[] = Array.isArray(rawInstructions) ? rawInstructions : [];

    // Collect all timeline entries (ignore pinned tweets when paginating history)
    const rawEntries: JsonRecord[] = [];
    const isHistoryDig = Boolean(bottomCursor && bottomCursor.length > 0);
    for (const rawInst of instructions) {
      const inst = asRecord(rawInst);
      if (inst.type === 'TimelinePinEntry' && inst.entry && !isHistoryDig) {
        rawEntries.push(asRecord(inst.entry));
      } else if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
        rawEntries.push(...inst.entries.map((e) => asRecord(e)));
      }
    }
    const seenTweetIds = new Set<string>();
    /**
     * Tweet-shaped entries the payload actually carried, counted BEFORE any
     * filtering. Distinguishes "the timeline's posts were all retweets or all
     * already known" (a healthy empty result) from "the page returned no tweets
     * at all" — the latter means the GraphQL response is no longer what this
     * parser expects (operation id / shape changed, or the session is not
     * authenticated), and reporting it as a successful zero-post sync would
     * hide that indefinitely.
     */
    let tweetEntriesSeen = 0;
    /** How the entries that produced no post were dropped — see the warn below. */
    let retweetsSkipped = 0;
    let unparsableEntriesSkipped = 0;
    /** Key NAMES (never values) of the first entry, to diagnose shape drift. */
    let firstEntryShape: string | undefined;
    /** Posts whose whole body was a bare t.co link, plus a field-map sample. */
    let linkOnlyCount = 0;
    let linkOnlyProbe: string | undefined;


    for (const entry of rawEntries) {
      if (posts.length >= limit) break;
      const entryId = typeof entry.entryId === 'string' ? entry.entryId : '';
      if (!entryId.startsWith('tweet-')) continue;
      tweetEntriesSeen++;

      const content = asRecord(entry.content);
      const item = asRecord(entry.item);
      const itemContent = asRecord(content.itemContent ?? item.itemContent);
      // `tweet_results` carries the tweet at `.result`. The lookup used to read
      // `tweet_results.tweet_results.result` — one level too deep — so every
      // entry parsed to `{}` and every Twitter channel silently produced zero
      // posts regardless of the payload. The `||` that was meant to fall back
      // could never fire either, because `asRecord()` returns `{}` (truthy) for
      // a miss, so the left operand was always truthy.
      //
      // Read `result` from whichever level actually has it; older/alternate
      // payloads do nest it one level deeper.
      const tweetResultsNode = asRecord(itemContent.tweet_results);
      const tweetResult = asRecord(
        asRecord(tweetResultsNode.tweet_results).result ?? tweetResultsNode.result,
      );

      if (Object.keys(tweetResult).length === 0) {
        unparsableEntriesSkipped++;
        firstEntryShape ??= `条目 #${tweetEntriesSeen} 无推文正文`
          + `（itemContent 键：${Object.keys(itemContent).join(',') || '空'}；`
          + `tweet_results 键：${Object.keys(tweetResultsNode).join(',') || '空'}）`;
        continue;
      }

      const tweetResultTweet = asRecord(tweetResult.tweet);

      // Extract author meta from tweet core if not yet present
      if (!authorAvatar || !authorName || authorName.startsWith('@')) {
        // Visibility-limited tweets carry `core` one level down, under
        // `tweet`. The previous `||` fallback never ran (an empty `asRecord()`
        // is truthy), so those tweets lost their author name/avatar.
        const coreUserResults = firstFilled(
          asRecord(asRecord(asRecord(tweetResult.core).user_results).result),
          asRecord(asRecord(asRecord(tweetResultTweet.core).user_results).result),
        );
        const tweetCoreUser = firstFilled(
          asRecord(coreUserResults.legacy),
          coreUserResults,
        );

        const candidateAvatar =
          str(tweetCoreUser.profile_image_url_https) ||
          str(asRecord(tweetCoreUser.avatar).image_url) ||
          str(asRecord(tweetCoreUser.legacy).profile_image_url_https);

        if (!authorAvatar && candidateAvatar) {
          authorAvatar = candidateAvatar.includes('_normal.')
            ? candidateAvatar.replace('_normal.', '_bigger.')
            : candidateAvatar.replace('_normal', '_bigger');
        }

        const candidateName =
          str(tweetCoreUser.name) ||
          str(asRecord(tweetCoreUser.legacy).name);

        if ((!authorName || authorName.startsWith('@')) && candidateName) {
          authorName = candidateName;
        }
      }

      let tweet = asRecord(tweetResult.legacy);
      if (tweetResult.__typename === 'TweetWithVisibilityResults' && tweetResult.tweet) {
        tweet = asRecord(tweetResultTweet.legacy);
      }
      if (Object.keys(tweet).length === 0) {
        unparsableEntriesSkipped++;
        firstEntryShape ??= `条目 #${tweetEntriesSeen} 的 legacy 为空`
          + `（__typename=${str(tweetResult.__typename) || '无'}，`
          + `result 键：${Object.keys(tweetResult).join(',') || '空'}）`;
        continue;
      }

      // Record how the first parseable entry is shaped. Names and booleans
      // only — this ends up in the user-visible log panel, so it must not carry
      // post text or author data.
      if (!firstEntryShape) {
        const bodyText = str(tweet.full_text) || str(tweet.text);
        firstEntryShape = `__typename=${str(tweetResult.__typename) || '无'}`
          + `，legacy 键数=${Object.keys(tweet).length}`
          + `，有 retweeted_status_result=${'retweeted_status_result' in tweet ? '是' : '否'}`
          + `，正文以 "RT @" 开头=${bodyText.startsWith('RT @') ? '是' : '否'}`;
      }

      const tweetId = str(tweet.id_str) || entryId.replace('tweet-', '');
      if (seenTweetIds.has(tweetId)) continue;
      seenTweetIds.add(tweetId);

      // Media presence and author-typed URL count are needed while deciding what
      // the body is (see `isMediaOnlyLinkText`), so they are read here rather
      // than in the media section further down.
      const hasMedia = Array.isArray(asRecord(tweet.extended_entities).media)
        || Array.isArray(asRecord(tweet.entities).media);
      const authorUrlCount = Array.isArray(asRecord(tweet.entities).urls)
        ? (asRecord(tweet.entities).urls as unknown[]).length
        : 0;

      // Support long-form text (NoteTweets). X ships this under
      // `result.note_tweet` in some responses and the tweet's own
      // `legacy.note_tweet` in others; check every level rather than betting on
      // one, since a wrong bet silently degrades a long post to whatever its
      // `full_text` holds (often just the trailing t.co link).
      let fullText = str(tweet.full_text) || str(tweet.text);
      const noteTextRaw = firstFilled(
        asRecord(asRecord(asRecord(tweetResult.note_tweet).note_tweet_results).result),
        asRecord(asRecord(asRecord(tweetResultTweet.note_tweet).note_tweet_results).result),
        asRecord(asRecord(asRecord(tweet.note_tweet).note_tweet_results).result),
      ).text;
      const noteText = typeof noteTextRaw === 'string' ? noteTextRaw : '';
      if (noteText) {
        fullText = noteText;
      } else {
        // Not a note tweet, so `display_text_range` applies to `full_text`. This
        // is what removes the media's trailing t.co link from captions, and what
        // turns an image-only tweet into genuinely empty text (X sends `[0, 0]`).
        fullText = displayableTweetText(fullText, tweet.display_text_range);
      }

      // Belt and braces for the payloads that omit `display_text_range`: without
      // this, the fallback above hands back the media link as if it were the
      // author's text. See `isMediaOnlyLinkText`.
      if (isMediaOnlyLinkText(fullText, hasMedia, authorUrlCount)) {
        fullText = '';
      }

      // A body that is nothing but a shortened link means the caption did not
      // come from any path above. Record the field map — key NAMES, lengths and
      // counters only, never post text (AGENTS rule 11) — so one sync identifies
      // the real location instead of another round of guessing.
      //
      // `truncated` and the url-entity count are the two fields that settle
      // whether we are missing text or the post simply is a bare link:
      // `truncated: true` means X withheld the body; a url entity means the
      // author themselves posted the link.
      if (/^https:\/\/t\.co\/\w+$/.test(fullText.trim())) {
        linkOnlyCount++;
        linkOnlyProbe ??= [
          `truncated=${'truncated' in tweet ? String(tweet.truncated) : '无该字段'}`,
          `entities.urls=${Array.isArray(asRecord(tweet.entities).urls) ? (asRecord(tweet.entities).urls as unknown[]).length : 0}`,
          `display_text_range=${Array.isArray(tweet.display_text_range) ? (tweet.display_text_range as unknown[]).join('-') : '无'}`,
          `full_text 长度=${str(tweet.full_text).length}`,
          `note_tweet 长度=${noteText.length}`,
          `extended_entities.media=${Array.isArray(asRecord(tweet.extended_entities).media) ? (asRecord(tweet.extended_entities).media as unknown[]).length : 0}`,
        ].join('；');
      }

      // Check if this is a retweet
      const isRetweet = Boolean(tweet.retweeted_status_result);

      // If caller requested only original posts, skip retweets from consuming quota
      if (onlyOriginal && isRetweet) {
        retweetsSkipped++;
        continue;
      }

      if (isRetweet) {
        const rtResult = asRecord(asRecord(tweet.retweeted_status_result).result);
        const rtLegacy = firstFilled(
          asRecord(rtResult.legacy),
          asRecord(asRecord(rtResult.tweet).legacy),
        );
        const rtUserLegacy = asRecord(asRecord(asRecord(asRecord(rtResult.core).user_results).result).legacy);
        const origUser = str(rtUserLegacy.name) || str(rtUserLegacy.screen_name);
        if (Object.keys(rtLegacy).length && origUser) {
          fullText = `[转推 @${origUser}]:\n${str(rtLegacy.full_text) || str(rtLegacy.text) || fullText}`;
        }
      }

      const parsedTime = str(tweet.created_at) ? new Date(str(tweet.created_at)).getTime() : Date.now();
      const pubDate = Number.isFinite(parsedTime) ? parsedTime : Date.now();

      // Extract media
      const mediaList: Post['mediaList'] = [];
      const mediaSource =
        asRecord(tweet.extended_entities).media ||
        asRecord(tweet.entities).media ||
        asRecord(asRecord(asRecord(tweet.retweeted_status_result).result).legacy).extended_entities ||
        asRecord(asRecord(asRecord(asRecord(tweet.retweeted_status_result).result).tweet).legacy).extended_entities ||
        [];
      const mediaItems = Array.isArray(mediaSource) ? mediaSource : [];

      for (const rawM of mediaItems) {
        const m = asRecord(rawM);
        const mediaUrlHttps = str(m.media_url_https) || str(m.media_url);
        if (m.type === 'photo') {
          mediaList.push({
            type: 'image',
            previewUrl: mediaUrlHttps,
            originalUrl: `${mediaUrlHttps}?name=orig`,
          });
        } else if (m.type === 'video' || m.type === 'animated_gif') {
          const rawVariants = asRecord(m.video_info).variants;
          const variants: JsonValue[] = Array.isArray(rawVariants) ? rawVariants : [];
          const best = variants
            .map((v) => asRecord(v))
            .filter((v) => v.content_type === 'video/mp4')
            .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0];

          mediaList.push({
            type: 'video',
            previewUrl: mediaUrlHttps,
            originalUrl: str(best?.url) || mediaUrlHttps,
          });
        }
      }

      // X appends a `t.co` URL per attached medium and for a quoted tweet.
      // Removed here, before the title is derived from the first line, so a short
      // caption does not become "caption https://t.co/…" in bold.
      fullText = stripAppendedLinks(fullText, appendedLinkUrls(mediaItems, tweet));

      // Clean title. A bare link (or a body we could not read) makes a useless
      // card title, so fall back to the account-based one rather than printing
      // a shortened URL in bold above the same URL. A tweet with no text at all
      // gets no title either — the media speaks for itself, and a synthetic
      //「@handle 的推文」heading is pure noise above an image.
      const firstLine = fullText.split('\n')[0].trim();
      const usableTitle = firstLine.length > 0
        && firstLine.length < 50
        && !/^https?:\/\/\S+$/.test(firstLine);
      const title = fullText.trim().length === 0
        ? ''
        : usableTitle
          ? firstLine
          : `@${username} 的推文`;

      posts.push(buildPost(channel, {
        id: `twitter_${tweetId}`,
        title,
        content: fullText,
        mediaList,
        originalUrl: `https://x.com/${username}/status/${tweetId}`,
        publishedAt: pubDate,
        isRepost: isRetweet,
      }));
    }

    // Strictly sort newest first
    posts.sort((a, b) => b.publishedAt - a.publishedAt);

    // An authenticated timeline always carries at least one entry. Zero means
    // the payload is not the shape this parser reads, so say so instead of
    // reporting a successful sync with nothing in it (AGENTS rule 10 applies to
    // every platform, not only to the page-driven ones).
    if (tweetEntriesSeen === 0) {
      return {
        posts: [],
        error: fetchError(
          'parse',
          '推特接口未返回任何推文条目。常见原因：浏览器未登录 x.com、账号处于保护状态，或推特调整了内部接口。'
          + '可在浏览器打开该博主主页确认能正常看到推文后重试。',
        ),
      };
    }

    // Entries existed but produced nothing. That is legitimate when the whole
    // timeline is retweets and the caller asked for originals only — but it is
    // also exactly what a parser/shape drift looks like, so record which of the
    // two it was. Without this, a brand-new creator whose posts never appear
    // looks identical to one that genuinely has no original posts.
    if (posts.length === 0) {
      devLog.warn(
        'twitter',
        `${channel.displayName || channel.accountId} 的 ${tweetEntriesSeen} 个条目未产出任何动态`,
        `转推跳过 ${retweetsSkipped}，解析失败 ${unparsableEntriesSkipped}；首条结构：${firstEntryShape ?? '未取到'}`,
      );
    }

    // Posts were produced but their bodies carry no readable caption. Either the
    // account genuinely posts link-only media (fine) or the caption lives in a
    // field this parser does not read yet (not fine) — the sample says which.
    if (linkOnlyCount > 0) {
      devLog.warn(
        'twitter',
        `${channel.displayName || channel.accountId} 有 ${linkOnlyCount}/${posts.length} 条动态正文只有链接`,
        linkOnlyProbe ?? '',
      );
    }

    return {
      posts,
      authorMeta: {
        name: authorName,
        avatar: authorAvatar,
      },
      nextCursor: bottomCursor,
      hasMore: Boolean(bottomCursor),
      totalFetched: tweetEntriesSeen,
    };
  },
};
