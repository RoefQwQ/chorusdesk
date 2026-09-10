import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { IS_SERVICE_WORKER } from '../utils/runtime';
import type { JsonRecord, JsonValue } from '../utils/json';
import { asRecord } from '../utils/json';

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


    for (const entry of rawEntries) {
      if (posts.length >= limit) break;
      const entryId = typeof entry.entryId === 'string' ? entry.entryId : '';
      if (!entryId.startsWith('tweet-')) continue;

      const content = asRecord(entry.content);
      const item = asRecord(entry.item);
      const itemContent = asRecord(content.itemContent ?? item.itemContent);
      const tweetResult =
        asRecord(asRecord(asRecord(itemContent.tweet_results).tweet_results).result) ||
        asRecord(asRecord(asRecord(item.itemContent).tweet_results).result);

      if (!tweetResult || !Object.keys(tweetResult).length) continue;

      const tweetResultTweet = asRecord(tweetResult.tweet);

      // Extract author meta from tweet core if not yet present
      if (!authorAvatar || !authorName || authorName.startsWith('@')) {
        const coreUserResults =
          asRecord(asRecord(asRecord(tweetResult.core).user_results).result) ||
          asRecord(asRecord(asRecord(tweetResultTweet.core).user_results).result);
        const tweetCoreUser =
          asRecord(coreUserResults.legacy) ||
          coreUserResults ||
          asRecord(asRecord(coreUserResults).legacy);

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
      if (!tweet || !Object.keys(tweet).length) continue;

      const tweetId = str(tweet.id_str) || entryId.replace('tweet-', '');
      if (seenTweetIds.has(tweetId)) continue;
      seenTweetIds.add(tweetId);

      // Support long-form text (NoteTweets)
      let fullText = str(tweet.full_text) || str(tweet.text);
      const noteText =
        str(asRecord(asRecord(asRecord(tweetResult.note_tweet).note_tweet_results).result).text) ||
        str(asRecord(asRecord(asRecord(tweetResultTweet.note_tweet).note_tweet_results).result).text);
      if (noteText) {
        fullText = noteText;
      }

      // Check if this is a retweet
      const isRetweet = Boolean(tweet.retweeted_status_result);

      // If caller requested only original posts, skip retweets from consuming quota
      if (onlyOriginal && isRetweet) {
        continue;
      }

      if (isRetweet) {
        const rtResult = asRecord(asRecord(tweet.retweeted_status_result).result);
        const rtLegacy = asRecord(rtResult.legacy) || asRecord(asRecord(rtResult.tweet).legacy);
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

      // Clean title
      const firstLine = fullText.split('\n')[0].trim();
      const title = firstLine.length > 0 && firstLine.length < 50
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

    return {
      posts,
      authorMeta: {
        name: authorName,
        avatar: authorAvatar,
      },
      nextCursor: bottomCursor,
      hasMore: Boolean(bottomCursor),
    };
  },
};
