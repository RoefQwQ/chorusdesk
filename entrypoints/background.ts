import { defineBackground } from 'wxt/utils/define-background';
import { handleProxyImage } from '../src/infrastructure/chrome/messages/proxyImage';
import { handleBgFetch } from '../src/infrastructure/chrome/messages/bgFetch';
import { handleSyncRplayToken } from '../src/infrastructure/chrome/messages/rplaySync';
import { handleTwitterTimeline } from '../src/infrastructure/chrome/messages/twitterTimeline';
import { setupDeclarativeNetRules } from '../src/infrastructure/chrome/declarativeNetRequest';
import { handleAutoSyncAlarm, setupAutoSync } from '../src/infrastructure/chrome/autoSync';

export default defineBackground(() => {
  console.log('[Chorus] Background Service Worker ready');
  setupDeclarativeNetRules();
  setupAutoSync();

  chrome.runtime.onInstalled.addListener(() => {
    setupDeclarativeNetRules();
    setupAutoSync();
  });

  chrome.alarms?.onAlarm.addListener((alarm) => {
    handleAutoSyncAlarm(alarm);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'UPDATE_AUTO_SYNC') {
      setupAutoSync();
      sendResponse({ success: true });
      return false;
    }

    if (message.type === 'OPEN_DASHBOARD') {
      chrome.tabs.create({
        url: chrome.runtime.getURL('/dashboard.html'),
      });
      sendResponse({ success: true });
      return false;
    }

    if (message.type === 'SAVE_RPLAY_TOKEN') {
      if (message.token && typeof message.token === 'string') {
        chrome.storage?.local?.set({ rplay_auth_token: message.token });
      }
      sendResponse({ success: true });
      return false;
    }

    if (message.type === 'BG_FETCH') {
      return handleBgFetch(message, sendResponse);
    }

    if (message.type === 'PROXY_IMAGE') {
      return handleProxyImage(message, sendResponse);
    }

    if (message.type === 'SYNC_RPLAY_TOKEN') {
      return handleSyncRplayToken(message, sendResponse);
    }

    if (message.type === 'FETCH_TWITTER_TIMELINE') {
      return handleTwitterTimeline(message, sendResponse);
    }

    return false;
  });

  // Auto-sync Rplay auth token when user visits or navigates on rplay.live
  if (chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.url && tab.url.includes('rplay.live')) {
        try {
          const res = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => localStorage.getItem('_AUTHORIZATION_'),
          });
          const token = res?.[0]?.result;
          if (token && typeof token === 'string' && token.length > 8) {
            console.log('[Background] Auto-saved Rplay auth token from active tab');
            await chrome.storage.local.set({ rplay_auth_token: token });
          }
        } catch {
          // Tab may not be ready or page restricted
        }
      }
    });
  }

});
