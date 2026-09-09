import { defineBackground } from 'wxt/utils/define-background';
import { handleProxyImage } from '../src/infrastructure/chrome/messages/proxyImage';
import { handleBgFetch } from '../src/infrastructure/chrome/messages/bgFetch';
import { handleTwitterTimeline } from '../src/infrastructure/chrome/messages/twitterTimeline';
import { handleDouyinSnapshot } from '../src/infrastructure/chrome/messages/douyinSnapshot';
import { isExtensionPageSender } from '../src/infrastructure/chrome/messages/senderGuard';
import { setupDeclarativeNetRules } from '../src/infrastructure/chrome/declarativeNetRequest';
import { handleAutoSyncAlarm, setupAutoSync, updateUnreadBadge } from '../src/infrastructure/chrome/autoSync';

/**
 * Who may invoke each message type.
 *
 * `page` — the extension's own dashboard/popup only. Required for every channel
 * that fetches with the user's cookies, reads a stored token, or returns a
 * response body to the caller: without this, an injected frame or (should
 * `externally_connectable` ever be declared) a hostile web page could use the
 * background as an authenticated proxy over all our host permissions.
 *
 * A type absent from this table is refused. Adding a message type REQUIRES
 * adding it here; see AGENTS.md rule 4.
 */
const SENDER_POLICY: Record<string, 'page'> = {
  UPDATE_AUTO_SYNC: 'page',
  OPEN_DASHBOARD: 'page',
  BG_FETCH: 'page',
  PROXY_IMAGE: 'page',
  FETCH_TWITTER_TIMELINE: 'page',
  FETCH_DOUYIN_SNAPSHOT: 'page',
  REFRESH_BADGE: 'page',
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
    // Rplay support was removed (2026-09); purge the orphaned session token so
    // the credential does not linger in storage forever. Idempotent.
    void chrome.storage.local.remove('rplay_auth_token').catch(() => {});
  });

  chrome.alarms?.onAlarm.addListener((alarm) => {
    handleAutoSyncAlarm(alarm);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = typeof message?.type === 'string' ? message.type : '';
    const policy = SENDER_POLICY[type];
    const allowed = policy === 'page' ? isExtensionPageSender(sender) : false;

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

    if (type === 'REFRESH_BADGE') {
      void updateUnreadBadge().catch((e) => console.warn('[Chorus] Badge refresh failed:', e));
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

    if (type === 'BG_FETCH') {
      return handleBgFetch(message, sendResponse);
    }

    if (type === 'PROXY_IMAGE') {
      return handleProxyImage(message, sendResponse);
    }

    if (type === 'FETCH_TWITTER_TIMELINE') {
      return handleTwitterTimeline(message, sendResponse);
    }

    if (type === 'FETCH_DOUYIN_SNAPSHOT') {
      return handleDouyinSnapshot(message, sendResponse);
    }

    return false;
  });
});
