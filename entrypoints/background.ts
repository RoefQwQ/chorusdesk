import { defineBackground } from 'wxt/utils/define-background';
import { handleProxyImage } from '../src/infrastructure/chrome/messages/proxyImage';
import { handleBgFetch } from '../src/infrastructure/chrome/messages/bgFetch';
import { handleSyncRplayToken } from '../src/infrastructure/chrome/messages/rplaySync';
import { handleTwitterTimeline } from '../src/infrastructure/chrome/messages/twitterTimeline';
import {
  isContentScriptSenderOn,
  isExtensionPageSender,
} from '../src/infrastructure/chrome/messages/senderGuard';
import { setupDeclarativeNetRules } from '../src/infrastructure/chrome/declarativeNetRequest';
import { handleAutoSyncAlarm, setupAutoSync } from '../src/infrastructure/chrome/autoSync';

/**
 * Who may invoke each message type.
 *
 * `page` — the extension's own dashboard/popup only. Required for every channel
 * that fetches with the user's cookies, reads a stored token, or returns a
 * response body to the caller: without this, an injected frame or (should
 * `externally_connectable` ever be declared) a hostile web page could use the
 * background as an authenticated proxy over all our host permissions.
 *
 * `rplay-content` — our content script on rplay.live, which is the legitimate
 * origin of the token relay and is not an extension page.
 *
 * A type absent from this table is refused. Adding a message type REQUIRES
 * adding it here; see AGENTS.md rule 4.
 */
const SENDER_POLICY: Record<string, 'page' | 'rplay-content'> = {
  UPDATE_AUTO_SYNC: 'page',
  OPEN_DASHBOARD: 'page',
  BG_FETCH: 'page',
  PROXY_IMAGE: 'page',
  SYNC_RPLAY_TOKEN: 'page',
  FETCH_TWITTER_TIMELINE: 'page',
  SAVE_RPLAY_TOKEN: 'rplay-content',
};

export default defineBackground(() => {
  console.log('[Chorus] Background Service Worker ready');
  // DNR dynamic rules persist across browser restarts, so they are applied
  // only on install/update (onInstalled). Re-running remove+add on every SW
  // wake is wasted work and briefly unscopes the hotlink rules mid-window.
  // setupAutoSync still runs at startup: it is guarded by alarms.get and
  // cheap, and it must repair a missing alarm after a browser restart wiped
  // it (e.g. alarm cleared while the extension was disabled).
  void setupAutoSync().catch((e) => console.warn('[Chorus] Auto-sync setup failed:', e));

  chrome.runtime.onInstalled.addListener(() => {
    void setupDeclarativeNetRules().catch((e) =>
      console.warn('[Chorus] DNR setup failed:', e)
    );
    void setupAutoSync().catch((e) => console.warn('[Chorus] Auto-sync setup failed:', e));
  });

  chrome.alarms?.onAlarm.addListener((alarm) => {
    handleAutoSyncAlarm(alarm);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = typeof message?.type === 'string' ? message.type : '';
    const policy = SENDER_POLICY[type];
    const allowed =
      policy === 'page'
        ? isExtensionPageSender(sender)
        : policy === 'rplay-content'
          ? isContentScriptSenderOn(sender, 'rplay.live')
          : false;

    if (!allowed) {
      console.warn(`[Chorus] Refused '${type || '(untyped)'}' from`, sender?.url ?? sender?.id);
      sendResponse({ success: false, ok: false, error: '请求来源不受信任' });
      return false;
    }

    if (type === 'UPDATE_AUTO_SYNC') {
      void setupAutoSync().catch((e) => console.warn('[Chorus] Auto-sync update failed:', e));
      sendResponse({ success: true });
      return false;
    }

    if (type === 'OPEN_DASHBOARD') {
      chrome.tabs.create({
        url: chrome.runtime.getURL('/dashboard.html'),
      });
      sendResponse({ success: true });
      return false;
    }

    if (type === 'SAVE_RPLAY_TOKEN') {
      // Sender is already pinned to an rplay.live content script by SENDER_POLICY.
      if (message.token && typeof message.token === 'string') {
        void chrome.storage.local
          .set({ rplay_auth_token: message.token })
          .then(() => sendResponse({ success: true }))
          .catch((e) => sendResponse({ success: false, error: String(e) }));
        return true;
      }
      sendResponse({ success: false, error: '缺少凭证内容' });
      return false;
    }

    if (type === 'BG_FETCH') {
      return handleBgFetch(message, sendResponse);
    }

    if (type === 'PROXY_IMAGE') {
      return handleProxyImage(message, sendResponse);
    }

    if (type === 'SYNC_RPLAY_TOKEN') {
      return handleSyncRplayToken(message, sendResponse);
    }

    if (type === 'FETCH_TWITTER_TIMELINE') {
      return handleTwitterTimeline(message, sendResponse);
    }

    return false;
  });

  // Note: the former chrome.tabs.onUpdated token scrape was removed. It fired on
  // every tab load, gated on `tab.url.includes('rplay.live')` (a substring match
  // that also accepts hosts like `rplay.live.attacker.tld` — AGENTS.md rule 1),
  // and read only `_AUTHORIZATION_`. The rplay.live content script already covers
  // every case it did, reads more candidate keys, and needs no tab scanning.
});
