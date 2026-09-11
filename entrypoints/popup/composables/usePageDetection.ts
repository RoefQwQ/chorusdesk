import { computed, ref } from 'vue';
import { parseProfileUrl, type ParsedProfile } from '../../../src/utils/urlParser';
import { toSecureMediaUrl } from '../../../src/utils/media';
import { bgFetch } from '../../../src/infrastructure/chrome/http';
import { collectDouyinSnapshot } from '../../../src/adapters/douyin/collector';

export interface AuthorMeta {
  name?: string;
  avatar?: string;
}

/**
 * Popup page detection: recognizes the active-tab profile URL, extracts the
 * author's real name / avatar (in-page DOM script + authoritative Bilibili
 * public User Card API) and tracks the current tab URL state.
 *
 * Owns no follow-form state: only URL / recognition / author-meta state.
 */
export function usePageDetection() {
  const loading = ref(true);
  const currentUrl = ref('');
  const manualUrl = ref('');
  const parsed = ref<ParsedProfile | null>(null);
  const detectedAuthorMeta = ref<AuthorMeta>({});
  const activeDisplayName = computed(() => {
    if (detectedAuthorMeta.value.name) return detectedAuthorMeta.value.name;
    if (parsed.value?.suggestedName && parsed.value.suggestedName !== parsed.value.accountId) {
      return parsed.value.suggestedName;
    }
    return parsed.value?.suggestedName || parsed.value?.accountId || '';
  });

  function resolveUrl(urlStr: string): ParsedProfile | null {
    const res = parseProfileUrl(urlStr);
    parsed.value = res;
    return res;
  }

  /** Returns the active tab of the current window, or null when unavailable. */
  async function getActiveTab(): Promise<{ id?: number; url?: string } | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    return { id: tab.id, url: tab.url };
  }

  /**
   * Authoritative Bilibili fallback: public User Card API directly by UID.
   * Updates detectedAuthorMeta; returns the applied real name (if any) so the
   * caller can pre-fill the follow form.
   */
  async function fetchBilibiliCard(accountId: string): Promise<string | undefined> {
    try {
      const cardRes = await bgFetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(accountId)}`);
      if (cardRes.ok && cardRes.data) {
        const cardJson = JSON.parse(cardRes.data);
        if (cardJson?.code === 0 && cardJson?.data?.card) {
          const cardData = cardJson.data.card;
          if (cardData.name) {
            detectedAuthorMeta.value.name = cardData.name;
          }
          if (cardData.face) {
            detectedAuthorMeta.value.avatar = toSecureMediaUrl(cardData.face);
          }
          return cardData.name;
        }
      }
    } catch (e) {
      console.warn('[Popup] Bilibili card API fetch skipped:', e);
    }
    return undefined;
  }

  /**
   * Douyin author meta comes from the shared collector, not from a second copy of
   * the page selectors here.
   *
   * The generic in-page script below has no Douyin branch and its meta-tag
   * fallback does not help: a creator page's og:title is the site name and its
   * og:image is not the avatar, so quick-follow used to fall back to the
   * "抖音用户_xxxxxx" placeholder and a letter avatar. Reusing
   * `collectDouyinSnapshot` keeps douyin.com's DOM shape confined to the
   * acquisition layer (AGENTS.md rule 9), so a Douyin redesign is still a
   * one-file fix.
   */
  async function extractDouyinAuthorMeta(tabId: number): Promise<string | undefined> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: collectDouyinSnapshot,
        // Author identity only — quick-follow does not need the work grid.
        args: [0],
      });
      const snapshot = results?.[0]?.result;
      if (!snapshot || typeof snapshot !== 'object') return undefined;
      if (snapshot.authorName) {
        detectedAuthorMeta.value.name = snapshot.authorName;
      }
      if (snapshot.authorAvatar) {
        detectedAuthorMeta.value.avatar = toSecureMediaUrl(snapshot.authorAvatar);
      }
    } catch (e) {
      console.warn('[Popup] Douyin author extraction skipped:', e);
    }
    return detectedAuthorMeta.value.name;
  }

  /**
   * Executes a lightweight in-page DOM script to extract the author's real name
   * & avatar from the current active tab, then (for Bilibili) upgrades the
   * result with the authoritative User Card API. Returns the final detected
   * author name (when any) so the caller can pre-fill the follow form.
   */
  async function extractActiveTabAuthorMeta(tabId: number, tabUrl?: string): Promise<string | undefined> {
    if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return undefined;
    if (!tabUrl || /^(chrome|edge|about|devtools):/i.test(tabUrl)) return undefined;

    // Douyin has its own collector; the generic script has no branch for it.
    if (parsed.value?.platform === 'douyin') {
      return await extractDouyinAuthorMeta(tabId);
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          let name = '';
          let avatar = '';
          const host = window.location.hostname.toLowerCase();

          // 1. YouTube
          if (host.includes('youtube.com')) {
            // Name
            const ytNameEl = document.querySelector('ytd-channel-name yt-formatted-string, #channel-name #text, #channel-header #text');
            if (ytNameEl?.textContent?.trim()) {
              name = ytNameEl.textContent.trim();
            } else {
              const ogTitle = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.content;
              if (ogTitle) {
                name = ogTitle.trim();
              } else if (document.title) {
                name = document.title.replace(/\s*-\s*YouTube$/i, '').trim();
              }
            }
            // Avatar
            const ytAvatarImg = document.querySelector('#channel-header img#img, ytd-channel-avatar-editor img, #avatar img') as HTMLImageElement;
            if (ytAvatarImg?.src && !ytAvatarImg.src.startsWith('data:')) {
              avatar = ytAvatarImg.src;
            } else {
              const ogImg = (document.querySelector('meta[property="og:image"]') as HTMLMetaElement)?.content;
              if (ogImg) avatar = ogImg;
            }
          }
          // 2. Twitter / X
          else if (host.includes('twitter.com') || host.includes('x.com')) {
            const userNameEl = document.querySelector('div[data-testid="UserName"]');
            if (userNameEl) {
              const spans = Array.from(userNameEl.querySelectorAll('span'));
              // First non-empty span that doesn't start with @
              const titleSpan = spans.find(s => s.textContent?.trim() && !s.textContent.trim().startsWith('@'));
              if (titleSpan?.textContent?.trim()) {
                name = titleSpan.textContent.trim();
              }
            }

            // Exclude viewer's own avatar (e.g. in left sidebar [data-testid="SideNav_AccountSwitcher_Button"])
            // Look specifically within the profile header or primary column
            const profileHeader = document.querySelector('[data-testid="primaryColumn"], main[role="main"]');
            if (profileHeader) {
              // The main profile avatar on X is typically an <a> linking to photo or containing a large avatar
              const avatarCandidates = Array.from(
                profileHeader.querySelectorAll<HTMLImageElement>(
                  'a[href$="/photo"] img, [data-testid="UserAvatar-Container-unknown"] img, [data-testid="UserProfileHeader-avatar"] img, [data-testid*="UserAvatar"] img'
                )
              );
              for (const img of avatarCandidates) {
                // Ensure it's not the sidebar button avatar
                if (!img.closest('[data-testid="SideNav_AccountSwitcher_Button"], header[role="banner"]')) {
                  if (img.src && !img.src.startsWith('data:')) {
                    avatar = img.src;
                    break;
                  }
                }
              }
            }
          }
          else if (host.includes('bilibili.com')) {
            // Exclude viewer's top navigation bar (.bili-header, .mini-header, etc.)
            const notInGlobalHeader = (el: Element | null): boolean => {
              if (!el) return false;
              return !el.closest('#bili-header, .bili-header, .bili-header__bar, .mini-header, .international-header');
            };

            // 1. Author name
            const nameCandidates = [
              document.querySelector('#h-name'),
              document.querySelector('#space-header #h-name'),
              document.querySelector('.up-name'),
              document.querySelector('.user-name'),
              document.querySelector('.nickname'),
            ];
            for (const cand of nameCandidates) {
              if (cand && notInGlobalHeader(cand) && cand.textContent?.trim()) {
                name = cand.textContent.trim();
                break;
              }
            }

            // 2. Creator avatar strictly within space header / UP info
            const spaceHeader = document.querySelector('#wrapper #header, #space-header, .space-header, #h-center, .space-header-avatar, #h-avatar');
            if (spaceHeader) {
              const upAvatarImg = spaceHeader.querySelector('#h-avatar img, .h-avatar img, img[src*="bfs/face"], img[src*="hdslb.com/bfs/face"], img') as HTMLImageElement | null;
              if (upAvatarImg && notInGlobalHeader(upAvatarImg)) {
                avatar = upAvatarImg.currentSrc || upAvatarImg.src || '';
              }
            }

            if (!avatar) {
              // Find avatars specifically excluding top header
              const avatarNodes = Array.from(document.querySelectorAll('#h-avatar img, .space-header-avatar img, .up-info__avatar img, img[src*="hdslb.com/bfs/face"]'));
              for (const node of avatarNodes) {
                if (notInGlobalHeader(node) && (node as HTMLImageElement).src) {
                  avatar = (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src;
                  break;
                }
              }
            }
          }
          // 4. Xiaohongshu
          else if (host.includes('xiaohongshu.com')) {
            const xhsName = document.querySelector('.user-name, .user-nickname, .info-part .name')?.textContent?.trim();
            if (xhsName) name = xhsName;
            const xhsAvatar = (document.querySelector('.avatar-wrapper img, .user-avatar img') as HTMLImageElement)?.src;
            if (xhsAvatar) avatar = xhsAvatar;
          }
          // 5. Weibo
          else if (host.includes('weibo.com') || host.includes('weibo.cn')) {
            const wbName = document.querySelector('.profile_name, .username')?.textContent?.trim();
            if (wbName) name = wbName;
            const wbAvatar = (document.querySelector('.profile_avatar img, .woo-avatar-main') as HTMLImageElement)?.src;
            if (wbAvatar) avatar = wbAvatar;
          }

          // Fallback meta tags
          if (!name) {
            const ogTitle = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.content;
            if (ogTitle) name = ogTitle.trim();
          }
          if (!avatar) {
            const ogImg = (document.querySelector('meta[property="og:image"]') as HTMLMetaElement)?.content;
            if (ogImg) avatar = ogImg;
          }

          return { name, avatar };
        },
      });

      if (results?.[0]?.result) {
        const { name, avatar } = results[0].result;
        if (name) {
          detectedAuthorMeta.value.name = name;
        }
        if (avatar) {
          detectedAuthorMeta.value.avatar = toSecureMediaUrl(avatar);
        }
      }

      // Authoritative fallback for Bilibili: public User Card API directly by UID
      if (parsed.value?.platform === 'bilibili' && parsed.value.accountId) {
        await fetchBilibiliCard(parsed.value.accountId);
      }
    } catch (err) {
      console.warn('Scripting DOM extraction skipped or not allowed on this tab:', err);
    }
    return detectedAuthorMeta.value.name;
  }

  return {
    loading,
    currentUrl,
    manualUrl,
    parsed,
    detectedAuthorMeta,
    activeDisplayName,
    resolveUrl,
    getActiveTab,
    fetchBilibiliCard,
    extractActiveTabAuthorMeta,
  };
}
