// Handles FETCH_TWITTER_TIMELINE: fetches a Twitter user timeline through the
// page-context path (existing x.com tab or a short-lived temporary background
// tab) with a direct cookie-based Service Worker fetch as fallback. Moved
// verbatim out of the background entrypoint so it only wires imports.
//
// Message contract (unchanged):
//   in:  { type: 'FETCH_TWITTER_TIMELINE', username, limit, onlyOriginal, cursor }
//   out: { success: true, tweetData, userData, bottomCursor }
//      | { success: false, error }
//
// **THE INJECTED FUNCTION MUST BE SELF-CONTAINED.** `chrome.scripting.executeScript`
// serializes it with `Function.prototype.toString()`, so it carries no closure:
// every identifier it references has to be a parameter, a local, or a page global.
// A module-scope reference compiles, passes every test that calls the function
// object, and then throws in the real page — which is exactly how `Bearer
// ${TWITTER_BEARER_TOKEN}` broke this path silently: the failure is caught by the
// injected function's own try/catch and reported as a plain error, so the timeline
// just fell through to the direct fetch and nobody could tell the page path had
// never run. Constants travel through `args`. `tests/twitterTimeline.injected.test.ts`
// pins this by evaluating the function's SOURCE with no closure.
import { errorMessage } from '../../../utils/errorMessage';
import { devLog } from '../../../utils/devLog';
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

// The GraphQL feature/field-toggle sets x.com's web client sends. Defined ONCE:
// both the direct fetch and the injected page script must send the same
// configuration to the same endpoint, and they used to carry a hand-maintained
// copy each, ~200 lines apart in this file. The injected script cannot read
// module scope (see the header), so these travel through `executeScript` args.
const USER_FEATURES: Record<string, boolean> = {
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

const USER_FIELD_TOGGLES: Record<string, boolean> = {
withPayments: false, withAuxiliaryUserLabels: false
};

const TWEET_FEATURES: Record<string, boolean> = {
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

const TWEET_FIELD_TOGGLES: Record<string, boolean> = {
      withPayments: false,
      withAuxiliaryUserLabels: false,
      withArticleRichContentState: false,
      withArticlePlainText: false,
      withArticleSummaryText: false,
      withArticleVoiceOver: false,
      withGrokAnalyze: false,
      withDisallowedReplyControls: false,
};

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

/**
 * The path a sync actually took has to be observable.
 *
 * It was not, and that cost a real diagnosis: the direct attempt calls native
 * `fetch` in the service worker rather than `bgFetch`, so it writes no `bgFetch:`
 * line, and its failure warning went to `console.warn` — which the dashboard's
 * Developer Log does not capture. A user's full sync log therefore showed
 * `消息 FETCH_TWITTER_TIMELINE` followed immediately by 「同步完成」with no way to
 * tell whether the page path ran, the direct path ran, or the direct path failed
 * and the fallback rescued it. Those are three different states of the system and
 * the fix for one of them (the injected function once referenced module scope and
 * never ran at all) is exactly what you would want to confirm.
 *
 * So: the path is logged. Successes at `debug` (visible with the panel's verbose
 * switch, silent otherwise — the log is a product surface, rule 20), and any
 * fallback at `warn`, because that is the branch that used to fail invisibly.
 */
async function fetchTwitterTimelineDirect(username: string, limit: number, onlyOriginal: boolean, cursor: string): Promise<{ success: boolean; error?: string; tweetData?: unknown; userData?: unknown } | null> {
  try {
    const [ct0Cookie, authCookie] = await Promise.all([
      chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }).then(value => value || chrome.cookies.get({ url: 'https://twitter.com', name: 'ct0' })),
      chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' }).then(value => value || chrome.cookies.get({ url: 'https://twitter.com', name: 'auth_token' })),
    ]);
    if (!ct0Cookie?.value || !authCookie?.value) {
      devLog.debug('twitter', '直连跳过：缺少 x.com 会话 Cookie，改走标签页路径');
      return null;
    }
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
    const userController = new AbortController();
    const userTimer = setTimeout(() => userController.abort(), 8_000);
    let userResponse: Response;
    try {
      userResponse = await fetch(endpoint('Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName', {
        screen_name: username,
        withSafetyModeUserFields: true,
      }, USER_FEATURES, USER_FIELD_TOGGLES), { headers, credentials: 'include', signal: userController.signal });
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
      tweetResponse = await fetch(endpoint('eviprbEPLvNG88V3smUngQ/UserTweets', variables, TWEET_FEATURES, TWEET_FIELD_TOGGLES), { headers, credentials: 'include', signal: tweetController.signal });
    } finally {
      clearTimeout(tweetTimer);
    }
    if (!tweetResponse.ok) return { success: false, error: `获取推特动态失败 (HTTP ${tweetResponse.status})` };
    devLog.debug('twitter', '直连请求成功');
    return { success: true, tweetData: await tweetResponse.json(), userData };
  } catch (error: unknown) {
    console.warn('[Background] Direct Twitter request failed; trying tab fallback:', error);
    devLog.warn('twitter', '直连请求失败，改走标签页路径', errorMessage(error));
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
    devLog.warn('twitter', '标签页路径不可用：缺少 tabs/scripting 能力');
    return { success: false, error: 'Background 缺少标签页访问或脚本注入能力' };
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
      devLog.debug('twitter', '标签页路径：复用已打开的 x.com 标签页');
    } else {
      devLog.debug('twitter', '标签页路径：未找到 x.com 标签页，新建后台临时页');
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
      func: async (
        user: string,
        count: number,
        onlyOrig: boolean,
        cur: string,
        config: {
          /** x.com's public guest bearer — passed in because this function has no closure. */
          bearer: string;
          userFeatures: Record<string, boolean>;
          userFieldToggles: Record<string, boolean>;
          tweetFeatures: Record<string, boolean>;
          tweetFieldToggles: Record<string, boolean>;
        },
      ) => {
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

          // The GraphQL feature sets arrive as arguments, not from module scope:
          // chrome.scripting serializes this function, so it has no closure (see the
          // file header). Stringified here so the request is byte-identical to the
          // direct path's — `tests/twitterTimeline.injected.test.ts` asserts that.
          const userFt = JSON.stringify(config.userFeatures);
          const userFieldToggles = JSON.stringify(config.userFieldToggles);
          const tweetFt = JSON.stringify(config.tweetFeatures);
          const tweetFieldToggles = JSON.stringify(config.tweetFieldToggles);

          const headers: Record<string, string> = {
            Authorization: `Bearer ${config.bearer}`,
            'x-csrf-token': ct0,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-client-language': 'zh-cn',
            Accept: '*/*',
          };

          // 1. UserByScreenName
          const userOp = 'Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName';
          const userVars = JSON.stringify({ screen_name: user, withSafetyModeUserFields: true });

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
          /** True when a timeline payload actually carries tweet entries. */
          const timelineHasTweets = (data: unknown): boolean =>
            readInstructions(data).some(
              (inst) =>
                (typeof inst === 'object' && inst !== null &&
                  ((inst as Record<string, unknown>).type === 'TimelineAddEntries' &&
                    Array.isArray((inst as Record<string, unknown>).entries) &&
                    ((inst as Record<string, unknown>).entries as Record<string, unknown>[]).some((e) =>
                      typeof e.entryId === 'string' && e.entryId.startsWith('tweet-')
                    ))) ||
                (typeof inst === 'object' && inst !== null && (inst as Record<string, unknown>).type === 'TimelinePinEntry')
            );

          if (!timelineHasTweets(tweetData)) {
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

          // `hasTweetEntries` is reported because the request succeeding and the
          // account yielding something visible are different facts, and the caller's
          // log used to conflate them: it printed 「标签页路径采集成功」 immediately
          // before the parser's 「同步失败（parse）· 未返回任何推文条目」 for a
          // protected account. The parser still owns the verdict; this only lets the
          // path log stop contradicting it one line later.
          return {
            success: true,
            tweetData,
            userData,
            bottomCursor,
            hasTweetEntries: timelineHasTweets(tweetData),
          };
        } catch (scriptErr: unknown) {
          return { success: false, error: scriptErr instanceof Error ? scriptErr.message : '推特标签页执行脚本异常' };
        }
      },
      args: [
        username,
        limit,
        Boolean(onlyOriginal),
        cursor || '',
        {
          bearer: TWITTER_BEARER_TOKEN,
          userFeatures: USER_FEATURES,
          userFieldToggles: USER_FIELD_TOGGLES,
          tweetFeatures: TWEET_FEATURES,
          tweetFieldToggles: TWEET_FIELD_TOGGLES,
        },
      ],
    });

    const res = tabResult?.[0]?.result;
    if (!res) {
      // Resolved with no result: the frame the script ran in is gone. Distinct
      // from a page that ran and reported a failure (rule 23).
      devLog.warn('twitter', '标签页注入未返回结果（页面可能发生跳转或重新渲染）', `tab ${targetTabId}`);
      return { success: false, error: '推特标签页未返回有效数据' };
    }
    if (!res.success) {
      devLog.warn('twitter', '标签页路径采集失败', String(res.error ?? '未知原因'));
    } else if ((res as { hasTweetEntries?: boolean }).hasTweetEntries === false) {
      // The request worked; the account simply yielded nothing visible. Reported at
      // `warn` because the adapter will fail this channel's sync one line later, and
      // the log should say why before it does.
      devLog.warn(
        'twitter',
        '标签页路径：请求成功，但响应中没有推文条目',
        `tab ${targetTabId}（受保护账号或接口变更；解析器将据此报错）`,
      );
    } else {
      devLog.debug('twitter', '标签页路径采集成功', `tab ${targetTabId}`);
    }
    return res;
  } catch (err: unknown) {
    // MUST catch rather than let this propagate. `chrome.scripting.executeScript`
    // REJECTS when the frame it was injected into is gone — the tab navigated or
    // was closed, or the permission was revoked — which is precisely the situation
    // this function's caller keeps a direct cookie-based fetch as a fallback for.
    // With only `try/finally`, the rejection skipped that fallback entirely and the
    // user got an error for a request the service worker could have served.
    // Returning a failed result (instead of throwing) is what makes the caller's
    // `pageResult?.success ? … : await fetchTwitterTimelineDirect(…)` reachable.
    // See AGENTS rule 23: an injection that resolved is not an injection that ran.
    devLog.warn('twitter', '标签页注入抛出异常', errorMessage(err, '推特标签页采集失败'));
    return { success: false, error: errorMessage(err, '推特标签页采集失败') };
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
