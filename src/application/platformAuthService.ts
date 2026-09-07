import {
  checkPlatformCookieLogins,
  getStoredRplayToken,
  requestSyncRplayToken,
  setStoredRplayToken,
  type PlatformAuthStatus,
  type RplaySyncResult,
} from '../infrastructure/chrome/platformAuth';

/**
 * Platform login / Rplay session facade for UI surfaces (Dashboard settings
 * login lamps, Popup Rplay sync banner). Thin wrapper over the Chrome
 * infrastructure layer — no cookie rules or platform knowledge live here;
 * they are defined once in `src/infrastructure/chrome/platformAuth.ts`.
 */
export const platformAuthService = {
  /**
   * Probe per-platform auth cookies / stored Rplay token. A key is left
   * absent (falsy in the UI) for platforms that are not probed; `youtube`
   * is always reported ready (public RSS).
   */
  async checkLogins(): Promise<PlatformAuthStatus> {
    return checkPlatformCookieLogins();
  },

  /** Read the stored Rplay session token (empty string when unavailable). */
  async getRplayToken(): Promise<string> {
    return getStoredRplayToken();
  },

  /**
   * Store (`token` non-empty) or clear (empty) the Rplay session token in
   * `chrome.storage.local`.
   */
  async setRplayToken(token: string): Promise<void> {
    await setStoredRplayToken(token);
  },

  /**
   * Ask the background to extract an Rplay auth token from an open
   * rplay.live tab. Never rejects; result carries `{ success, token?,
   * error? }` per the runtime message contract.
   */
  async syncRplayFromTab(): Promise<RplaySyncResult> {
    return requestSyncRplayToken();
  },
};
