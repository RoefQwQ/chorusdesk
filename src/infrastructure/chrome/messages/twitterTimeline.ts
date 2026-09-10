// Handles FETCH_TWITTER_TIMELINE: fetches a Twitter user timeline through the
// page-context path (existing x.com tab or a short-lived temporary background
// tab) with a direct cookie-based Service Worker fetch as fallback. Moved
// verbatim out of the background entrypoint so it only wires imports.
//
// Message contract (unchanged):
//   in:  { type: 'FETCH_TWITTER_TIMELINE', username, limit, onlyOriginal, cursor }
//   out: { success: true, tweetData, userData, bottomCursor }
//      | { success: false, error }
interface TwitterTimelineMessage {
  type: 'FETCH_TWITTER_TIMELINE';
  username?: unknown;
  limit?: unknown;
  onlyOriginal?: unknown;
  cursor?: unknown;
}

type SendResponse = (response?: unknown) => void;

// Public guest bearer token used by x.com's web GraphQL client.
const TWITTER_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/**
 * Handles FETCH_TWITTER_TIMELINE messages.
 *
 * Returns `true` so the runtime message channel stays open until the async
 * sendResponse fires — callers MUST return this value from the listener.
 */
export function handleTwitterTimeline(
  message: TwitterTimelineMessage,
  sendResponse: SendResponse,
): boolean {
  (async () => {
    try {
      const username = (message.username as string || '').replace(/^@/, '').trim();
      const limit = Number(message.limit) || 12;
      const onlyOriginal = Boolean(message.onlyOriginal);
      const cursor = typeof message.cursor === 'string' ? message.cursor : '';
      if (!username) {
        sendResponse({ success: false, error: '缺少推特用户名' });
        return;
      }

      // Keep the proven page-context path as primary; direct fetch is only a fallback.
      const pageResult = await fetchTwitterTimelineViaTabOrSession(username, limit, onlyOriginal, cursor);
      const directResult = pageResult?.success ? null : await fetchTwitterTimelineDirect(username, limit, onlyOriginal, cursor);
      sendResponse(pageResult?.success ? pageResult : (directResult || pageResult));
    } catch (err: unknown) {
      sendResponse({ success: false, error: err instanceof Error ? err.message : '获取推特动态异常' });
    }
  })();
  return true;
}

// Prefer direct Service Worker requests. This avoids opening a temporary x.com tab.
async function fetchTwitterTimelineDirect(username: string, limit: number, onlyOriginal: boolean, cursor: string): Promise<{ success: boolean; error?: string; tweetData?: unknown; userData?: unknown } | null> {
  try {
    const [ct0Cookie, authCookie] = await Promise.all([
      chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }).then(value => value || chrome.cookies.get({ url: 'https://twitter.com', name: 'ct0' })),
      chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' }).then(value => value || chrome.cookies.get({ url: 'https://twitter.com', name: 'auth_token' })),
    ]);
    if (!ct0Cookie?.value || !authCookie?.value) return null;
    const headers: Record<string, string> = {
      Accept: '*/*',
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
      'x-csrf-token': ct0Cookie.value,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'zh-cn',
    };
    const endpoint = (operation: string, variables: Record<string, unknown>, features: Record<string, unknown>, fieldToggles: Record<string, unknown>) => {
      return `https://x.com/i/api/graphql/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;
    };
    const userFeatures = {
      hidden_profile_subscriptions_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      subscriptions_verification_info_is_identity_verified_enabled: true,
      subscriptions_verification_info_verified_since_enabled: true,
      highlights_tweets_tab_ui_enabled: true,
      responsive_web_twitter_article_notes_tab_enabled: true,
      subscriptions_feature_can_gift_premium: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
    };
    const userFieldToggles = { withPayments: false, withAuxiliaryUserLabels: false };
    const tweetFeatures = {
      rweb_video_screen_enabled: true,
      rweb_cashtags_enabled: true,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      premium_content_api_read_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      responsive_web_grok_analyze_button_fetch_trends_enabled: false,
      responsive_web_grok_analyze_post_followups_enabled: false,
      rweb_cashtags_composer_attachment_enabled: true,
      responsive_web_jetfuel_frame: false,
      responsive_web_grok_share_attachment_enabled: true,
      responsive_web_grok_annotations_enabled: false,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      rweb_conversational_replies_downvote_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      content_disclosure_indicator_enabled: true,
      content_disclosure_ai_generated_indicator_enabled: true,
      responsive_web_grok_show_grok_translated_post: false,
      responsive_web_grok_analysis_button_from_backend: false,
      post_ctas_fetch_enabled: true,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_grok_image_annotation_enabled: false,
      responsive_web_grok_imagine_annotation_enabled: false,
      responsive_web_grok_community_note_auto_translation_is_enabled: false,
      responsive_web_enhance_cards_enabled: false,
    };
    const tweetFieldToggles = {
      withPayments: false,
      withAuxiliaryUserLabels: false,
      withArticleRichContentState: false,
      withArticlePlainText: false,
      withArticleSummaryText: false,
      withArticleVoiceOver: false,
      withGrokAnalyze: false,
      withDisallowedReplyControls: false,
    };
    const userController = new AbortController();
    const userTimer = setTimeout(() => userController.abort(), 8_000);
    let userResponse: Response;
    try {
      userResponse = await fetch(endpoint('Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName', {
        screen_name: username,
        withSafetyModeUserFields: true,
      }, userFeatures, userFieldToggles), { headers, credentials: 'include', signal: userController.signal });
    } finally {
      clearTimeout(userTimer);
    }
    if (!userResponse.ok) return { success: false, error: `查询推特用户 @${username} 失败 (HTTP ${userResponse.status})` };
    const userData: unknown = await userResponse.json();
    if (!userData || typeof userData !== 'object' || !('data' in userData)) return { success: false, error: '推特用户接口返回数据格式异常' };
    const userResult = userData.data;
    if (!userResult || typeof userResult !== 'object' || !('user' in userResult)) return { success: false, error: `未在推特找到该用户 (@${username})，请核对用户名是否正确。` };
    const userNode = userResult.user;
    if (!userNode || typeof userNode !== 'object' || !('result' in userNode)) return { success: false, error: `未在推特找到该用户 (@${username})，请核对用户名是否正确。` };
    const resultNode = userNode.result;
    if (!resultNode || typeof resultNode !== 'object' || !('rest_id' in resultNode) || typeof resultNode.rest_id !== 'string') return { success: false, error: `未在推特找到该用户 (@${username})，请核对用户名是否正确。` };
    const variables: Record<string, unknown> = {
      userId: resultNode.rest_id,
      count: onlyOriginal ? Math.min(Math.max(limit * 3, 25), 45) : limit,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true,
      withV2Timeline: true,
    };
    if (cursor) variables.cursor = cursor;
    const tweetController = new AbortController();
    const tweetTimer = setTimeout(() => tweetController.abort(), 8_000);
    let tweetResponse: Response;
    try {
      tweetResponse = await fetch(endpoint('eviprbEPLvNG88V3smUngQ/UserTweets', variables, tweetFeatures, tweetFieldToggles), { headers, credentials: 'include', signal: tweetController.signal });
    } finally {
      clearTimeout(tweetTimer);
    }
    if (!tweetResponse.ok) return { success: false, error: `获取推特动态失败 (HTTP ${tweetResponse.status})` };
    return { success: true, tweetData: await tweetResponse.json(), userData };
  } catch (error: unknown) {
    console.warn('[Background] Direct Twitter request failed; trying tab fallback:', error);
    return null;
  }
}

// Fallback uses an existing x.com tab, or a temporary tab when direct cookies are unavailable.
async function fetchTwitterTimelineViaTabOrSession(
  username: string,
  limit: number,
  onlyOriginal: boolean = false,
  cursor: string = ''
) {
  if (!chrome.tabs || !chrome.scripting) {
    return { success: false, error: 'Background 缺少 tabs 或 scripting 权限' };
  }

  let targetTabId: number | null = null;
  let isTempTab = false;

  try {
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const existingTab = allTabs.find(t =>
      t.id &&
      t.url &&
      (t.url.includes('x.com') || t.url.includes('twitter.com')) &&
      !t.url.includes('/i/flow/login')
    );

    if (existingTab && existingTab.id) {
      targetTabId = existingTab.id;
    } else {
      // Create an inactive background tab so the user is not disrupted
      const tempTab = await chrome.tabs.create({
        url: 'https://x.com/?ref=cfh_sync',
        active: false,
      });
      targetTabId = tempTab.id || null;
      isTempTab = true;

      // Wait up to 4.5s for tab to initialize
      await new Promise<void>((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        }, 4500);

        function onUpdated(tabId: number, info: { status?: string; title?: string }) {
          if (tabId === tempTab.id && (info.status === 'complete' || info.title)) {
            if (!done) {
              done = true;
              clearTimeout(timer);
              chrome.tabs.onUpdated.removeListener(onUpdated);
              setTimeout(resolve, 500);
            }
          }
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
      });
    }

    if (!targetTabId) {
      return {
        success: false,
        error: '未能连接推特标签页。请先在浏览器中新建标签页打开 x.com 并确认已登录。',
      };
    }

    const tabResult = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: async (user: string, count: number, onlyOrig: boolean, cur: string) => {
        try {
          // Read ct0 from document.cookie
          const ct0Match = document.cookie.match(/(?:^|;\s*)ct0=([a-zA-Z0-9_-]+)/);
          const ct0 = ct0Match ? ct0Match[1] : '';
          if (!ct0) {
            return {
              success: false,
              error: '推特页面中未检测到登录凭据 (ct0)。请确认当前浏览器已在 x.com 登录。',
            };
          }

          const headers: Record<string, string> = {
            Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
            'x-csrf-token': ct0,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-client-language': 'zh-cn',
            Accept: '*/*',
          };

          // 1. UserByScreenName
          const userOp = 'Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName';
          const userVars = JSON.stringify({ screen_name: user, withSafetyModeUserFields: true });
          const userFt = JSON.stringify({
            hidden_profile_subscriptions_enabled: true,
            rweb_tipjar_consumption_enabled: true,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            subscriptions_verification_info_is_identity_verified_enabled: true,
            subscriptions_verification_info_verified_since_enabled: true,
            highlights_tweets_tab_ui_enabled: true,
            responsive_web_twitter_article_notes_tab_enabled: true,
            subscriptions_feature_can_gift_premium: true,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
          });
          const userFieldToggles = JSON.stringify({
            withPayments: false,
            withAuxiliaryUserLabels: false,
          });

          const userResp = await fetch(
            `/i/api/graphql/${userOp}?variables=${encodeURIComponent(userVars)}&features=${encodeURIComponent(userFt)}&fieldToggles=${encodeURIComponent(userFieldToggles)}`,
            { headers, credentials: 'include' }
          );

          if (!userResp.ok) {
            if (userResp.status === 429) {
              return { success: false, error: '推特用户查询接口频率受限 (HTTP 429)。请稍等 2~5 分钟冷却后再试。' };
            }
            return { success: false, error: `查询推特用户 @${user} 失败 (HTTP ${userResp.status})` };
          }

          const userData = await userResp.json();
          const restId = userData?.data?.user?.result?.rest_id;
          if (!restId) {
            return { success: false, error: `未在推特找到该用户 (@${user})，请核对用户名是否正确。` };
          }

          // 2. UserTweets
          const tweetOp = 'eviprbEPLvNG88V3smUngQ/UserTweets';
          // Sample wider window if onlyOriginal requested so retweets do not squeeze out originals
          const sampleCount = onlyOrig ? Math.min(Math.max(count * 3, 25), 45) : (count || 15);
          const tweetVarsObj: Record<string, string | number | boolean> = {
            userId: restId,
            count: sampleCount,
            includePromotedContent: false,
            withQuickPromoteEligibilityTweetFields: true,
            withVoice: true,
            withV2Timeline: true,
          };
          if (cur && cur.trim()) {
            tweetVarsObj.cursor = cur.trim();
          }
          const tweetVars = JSON.stringify(tweetVarsObj);
          const tweetFt = JSON.stringify({
            rweb_video_screen_enabled: true,
            rweb_cashtags_enabled: true,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            responsive_web_profile_redirect_enabled: true,
            rweb_tipjar_consumption_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            premium_content_api_read_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            responsive_web_grok_analyze_button_fetch_trends_enabled: false,
            responsive_web_grok_analyze_post_followups_enabled: false,
            rweb_cashtags_composer_attachment_enabled: true,
            responsive_web_jetfuel_frame: false,
            responsive_web_grok_share_attachment_enabled: true,
            responsive_web_grok_annotations_enabled: false,
            articles_preview_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            rweb_conversational_replies_downvote_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            content_disclosure_indicator_enabled: true,
            content_disclosure_ai_generated_indicator_enabled: true,
            responsive_web_grok_show_grok_translated_post: false,
            responsive_web_grok_analysis_button_from_backend: false,
            post_ctas_fetch_enabled: true,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_grok_image_annotation_enabled: false,
            responsive_web_grok_imagine_annotation_enabled: false,
            responsive_web_grok_community_note_auto_translation_is_enabled: false,
            responsive_web_enhance_cards_enabled: false,
          });
          const tweetFieldToggles = JSON.stringify({
            withPayments: false,
            withAuxiliaryUserLabels: false,
            withArticleRichContentState: false,
            withArticlePlainText: false,
            withArticleSummaryText: false,
            withArticleVoiceOver: false,
            withGrokAnalyze: false,
            withDisallowedReplyControls: false,
          });

          const tweetResp = await fetch(
            `/i/api/graphql/${tweetOp}?variables=${encodeURIComponent(tweetVars)}&features=${encodeURIComponent(tweetFt)}&fieldToggles=${encodeURIComponent(tweetFieldToggles)}`,
            { headers, credentials: 'include' }
          );

          if (!tweetResp.ok) {
            if (tweetResp.status === 429) {
              return { success: false, error: '推特动态接口频率受限 (HTTP 429)。请等待 2~5 分钟冷却后再试。' };
            }
            return { success: false, error: `获取推文动态失败 (HTTP ${tweetResp.status})` };
          }

          let tweetData: unknown = await tweetResp.json();

          const readInstructions = (data: unknown): unknown[] => {
            const user = (data as Record<string, unknown> | null)?.data as Record<string, unknown> | undefined;
            const userResult = user?.user as Record<string, unknown> | undefined;
            const result = userResult?.result as Record<string, unknown> | undefined;
            const v2 = result?.timeline_v2 as Record<string, unknown> | undefined;
            const v2Timeline = v2?.timeline as Record<string, unknown> | undefined;
            const tl = result?.timeline as Record<string, unknown> | undefined;
            const tlTimeline = tl?.timeline as Record<string, unknown> | undefined;
            const inst = v2Timeline?.instructions ?? tlTimeline?.instructions;
            return Array.isArray(inst) ? inst : [];
          };
          const instructions = readInstructions(tweetData);
          const hasTweetEntries = instructions.some(
            (inst) =>
              (typeof inst === 'object' && inst !== null &&
                ((inst as Record<string, unknown>).type === 'TimelineAddEntries' &&
                  Array.isArray((inst as Record<string, unknown>).entries) &&
                  ((inst as Record<string, unknown>).entries as Record<string, unknown>[]).some((e) =>
                    typeof e.entryId === 'string' && e.entryId.startsWith('tweet-')
                  ))) ||
              (typeof inst === 'object' && inst !== null && (inst as Record<string, unknown>).type === 'TimelinePinEntry')
          );

          if (!hasTweetEntries) {
            try {
              const replyOp = 'qUpkZU6eN8MbtQb7rC_pYg/UserTweetsAndReplies';
              const replyResp = await fetch(
                `/i/api/graphql/${replyOp}?variables=${encodeURIComponent(tweetVars)}&features=${encodeURIComponent(tweetFt)}&fieldToggles=${encodeURIComponent(tweetFieldToggles)}`,
                { headers, credentials: 'include' }
              );
              if (replyResp.ok) {
                const replyData = await replyResp.json();
                const replyInst = readInstructions(replyData);
                if (replyInst.some((inst) =>
                  typeof inst === 'object' && inst !== null &&
                  (inst as Record<string, unknown>).type === 'TimelineAddEntries' &&
                  Array.isArray((inst as Record<string, unknown>).entries) &&
                  ((inst as Record<string, unknown>).entries as unknown[]).length > 0
                )) {
                  tweetData = replyData;
                }
              }
            } catch {
              // Replies fallback failed: keep the original (empty) timeline.
            }
          }

          // Extract bottom pagination cursor if present
          let bottomCursor: string | undefined;
          for (const rawInst of readInstructions(tweetData)) {
            if (typeof rawInst !== 'object' || rawInst === null) continue;
            const inst = rawInst as Record<string, unknown>;
            if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
              for (const rawEntry of inst.entries) {
                if (typeof rawEntry !== 'object' || rawEntry === null) continue;
                const entry = rawEntry as Record<string, unknown>;
                const entryId = typeof entry.entryId === 'string' ? entry.entryId : '';
                const content = (entry.content ?? undefined) as Record<string, unknown> | undefined;
                const itemContent = (content?.itemContent ?? undefined) as Record<string, unknown> | undefined;
                if (
                  entryId.startsWith('cursor-bottom-') ||
                  content?.cursorType === 'Bottom' ||
                  content?.entryType === 'TimelineTimelineCursor'
                ) {
                  bottomCursor =
                    (typeof content?.value === 'string' ? content.value : undefined) ||
                    (typeof itemContent?.value === 'string' ? itemContent.value : undefined);
                }
              }
            }
          }

          return { success: true, tweetData, userData, bottomCursor };
        } catch (scriptErr: unknown) {
          return { success: false, error: scriptErr instanceof Error ? scriptErr.message : '推特标签页执行脚本异常' };
        }
      },
      args: [username, limit, Boolean(onlyOriginal), cursor || ''],
    });

    const res = tabResult?.[0]?.result;
    return res || { success: false, error: '推特标签页未返回有效数据' };
  } finally {
    // Clean up temporary tab if created
    if (isTempTab && targetTabId) {
      try {
        await chrome.tabs.remove(targetTabId);
      } catch {
        // Tab already gone: nothing to clean up.
      }
    }
}
}
