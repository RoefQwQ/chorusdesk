/**
 * Popup navigation: opens the Dashboard page. In the extension context this
 * uses `chrome.tabs.create` with the packaged `dashboard.html` URL; outside
 * the extension (plain-browser development) it falls back to `window.open`.
 *
 * Owns no follow-form or page-detection state — pure navigation, moved out of
 * App.vue so the entry layer stays composition-only.
 */
export function usePopupNavigation() {
  function openDashboard() {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({
        url: chrome.runtime.getURL('/dashboard.html'),
      });
    } else {
      window.open('/dashboard.html', '_blank');
    }
  }

  return { openDashboard };
}
