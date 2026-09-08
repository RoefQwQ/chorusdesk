import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { IS_SERVICE_WORKER } from '../utils/runtime';

export const twitterAdapter: PlatformAdapter = {
  platform: 'twitter',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    const username = channel.accountId.replace(/^@/, '').trim();

    // The SW never receives its own runtime.sendMessage, so from the
    // background (auto-sync) the FETCH_TWITTER_TIMELINE channel is unusable.
    if (IS_SERVICE_WORKER) {
      return {
        posts: [],
        error: '后台自动同步暂不支持推特（需在扩展页面中同步）',
      };
    }

    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return {
        posts: [],
        error: '当前运行环境不支持与扩展后台通信',
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
          error: '扩展后台服务未响应，请在 chrome://extensions 中重新加载插件后重试',
        };
      }

      if (!res.success) {
        return {
          posts: [],
          error: res.error || '获取推文失败',
        };
      }

      if (res.tweetData) {
        const parseGraphQLResult = this.parseGraphQLResult;
        if (!parseGraphQLResult) {
          return {
            posts: [],
            error: '推特解析器不可用',
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
        error: '推特未返回有效数据',
      };
    } catch (err: any) {
      return {
        posts: [],
        error: '调用推特同步后台失败: ' + (err?.message || err),
      };
    }
  },

  parseGraphQLResult(
    channel: Channel,
    tweetData: any,
    userData: any,
    limit: number,
    onlyOriginal?: boolean,
    bottomCursor?: string
  ): FetchResult {
    const posts: Post[] = [];
    const username = channel.accountId.replace(/^@/, '').trim();

    // Extract author profile with multiple GraphQL fallback paths
    const userRes = userData?.data?.user?.result;
    const userLegacy = userRes?.legacy;
    let authorName =
      userLegacy?.name ||
      userRes?.name ||
      channel.displayName ||
      `@${username}`;

    let authorAvatar =
      userLegacy?.profile_image_url_https ||
      userRes?.avatar?.image_url ||
      userLegacy?.avatar?.image_url ||
      userRes?.profile_image_url_https ||
      channel.avatarUrl ||
      '';

    // Upgrade avatar resolution to bigger/original
    if (authorAvatar.includes('_normal.')) {
      authorAvatar = authorAvatar.replace('_normal.', '_bigger.');
    } else if (authorAvatar.includes('_normal')) {
      authorAvatar = authorAvatar.replace('_normal', '_bigger');
    }

    const instructions =
      tweetData?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
      tweetData?.data?.user?.result?.timeline?.timeline?.instructions ||
      [];

    // Collect all timeline entries (ignore pinned tweets when paginating history)
    const rawEntries: any[] = [];
    const isHistoryDig = Boolean(bottomCursor && bottomCursor.length > 0);
    for (const inst of instructions) {
      if (inst.type === 'TimelinePinEntry' && inst.entry && !isHistoryDig) {
        rawEntries.push(inst.entry);
      } else if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
        rawEntries.push(...inst.entries);
      }
    }

    const seenTweetIds = new Set<string>();

    for (const entry of rawEntries) {
      if (posts.length >= limit) break;
      const entryId = entry.entryId || '';
      if (!entryId.startsWith('tweet-')) continue;

      const tweetResult =
        entry.content?.itemContent?.tweet_results?.result ||
        entry.item?.itemContent?.tweet_results?.result ||
        entry.itemContent?.tweet_results?.result;

      if (!tweetResult) continue;

      // Extract author meta from tweet core if not yet present
      if (!authorAvatar || !authorName || authorName.startsWith('@')) {
        const tweetCoreUser =
          tweetResult.core?.user_results?.result?.legacy ||
          tweetResult.tweet?.core?.user_results?.result?.legacy ||
          tweetResult.core?.user_results?.result ||
          tweetResult.tweet?.core?.user_results?.result;

        const candidateAvatar =
          tweetCoreUser?.profile_image_url_https ||
          tweetCoreUser?.avatar?.image_url ||
          tweetCoreUser?.legacy?.profile_image_url_https;

        if (!authorAvatar && candidateAvatar) {
          authorAvatar = candidateAvatar.includes('_normal.')
            ? candidateAvatar.replace('_normal.', '_bigger.')
            : candidateAvatar.replace('_normal', '_bigger');
        }

        const candidateName =
          tweetCoreUser?.name ||
          tweetCoreUser?.legacy?.name;

        if ((!authorName || authorName.startsWith('@')) && candidateName) {
          authorName = candidateName;
        }
      }

      let tweet = tweetResult.legacy;
      if (tweetResult.__typename === 'TweetWithVisibilityResults' && tweetResult.tweet) {
        tweet = tweetResult.tweet.legacy;
      }
      if (!tweet) continue;

      const tweetId = tweet.id_str || entryId.replace('tweet-', '');
      if (seenTweetIds.has(tweetId)) continue;
      seenTweetIds.add(tweetId);

      // Support long-form text (NoteTweets)
      let fullText = tweet.full_text || tweet.text || '';
      const noteText =
        tweetResult.note_tweet?.note_tweet_results?.result?.text ||
        tweetResult.tweet?.note_tweet?.note_tweet_results?.result?.text;
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
        const origLegacy =
          tweet.retweeted_status_result?.result?.legacy ||
          tweet.retweeted_status_result?.result?.tweet?.legacy;
        const origUser =
          tweet.retweeted_status_result?.result?.core?.user_results?.result?.legacy?.name ||
          tweet.retweeted_status_result?.result?.core?.user_results?.result?.legacy?.screen_name;
        if (origLegacy && origUser) {
          fullText = `[转推 @${origUser}]:\n${origLegacy.full_text || origLegacy.text || fullText}`;
        }
      }

      const pubDate = tweet.created_at ? new Date(tweet.created_at).getTime() : Date.now();

      // Extract media
      const mediaList: any[] = [];
      const mediaItems =
        tweet.extended_entities?.media ||
        tweet.entities?.media ||
        tweet.retweeted_status_result?.result?.legacy?.extended_entities?.media ||
        [];

      for (const m of mediaItems) {
        if (m.type === 'photo') {
          mediaList.push({
            type: 'image',
            previewUrl: m.media_url_https || m.media_url,
            originalUrl: `${m.media_url_https || m.media_url}?name=orig`,
          });
        } else if (m.type === 'video' || m.type === 'animated_gif') {
          const variants = m.video_info?.variants || [];
          const best = variants
            .filter((v: any) => v.content_type === 'video/mp4')
            .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];

          mediaList.push({
            type: 'video',
            previewUrl: m.media_url_https,
            originalUrl: best?.url || m.media_url_https,
          });
        }
      }

      // Clean title
      const firstLine = fullText.split('\n')[0].trim();
      const title = firstLine.length > 0 && firstLine.length < 50
        ? firstLine
        : `@${username} 的推文`;

      posts.push({
        id: `twitter_${tweetId}`,
        creatorId: channel.creatorId,
        channelId: channel.id,
        platform: 'twitter',
        title,
        content: fullText,
        mediaList,
        originalUrl: `https://x.com/${username}/status/${tweetId}`,
        publishedAt: pubDate,
        fetchedAt: Date.now(),
        isRead: 0,
        isRepost: isRetweet,
      });
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
