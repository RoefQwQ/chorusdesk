import { db } from '../../db/database';
import { updateChannel } from '../../../sync/channelSync';
import { errorMessage } from '../../../utils/errorMessage';

/**
 * `SYNC_CHANNEL` — the popup's post-follow initial fetch.
 *
 * It runs here rather than in the popup for two reasons, one of which is a real
 * defect it fixes:
 *
 *  - **The popup can be closed mid-fetch.** The popup called `updateChannel`
 *    directly and fire-and-forget, so dismissing the window during the first
 *    fetch aborted it — the channel was stored, its posts never were, and nothing
 *    retried. An MV3 worker, by contrast, is kept alive by the outstanding
 *    `sendResponse`, so the fetch completes whatever the UI does.
 *  - **The popup no longer bundles the platform adapters.** Importing `src/sync`
 *    from the popup pulled the whole registry — all ten adapters plus their
 *    parsers — into a window that shows one form. Now the popup sends a message
 *    and the worker, which already carries the adapters, does the work.
 *
 * The channel is looked up by **id**, never taken from the message: a message body
 * is caller-supplied, and the worker must not sync a channel record a page handed
 * it. The id is checked against the database that owns the data (AGENTS rule 4's
 * spirit: the router gates *who* may ask, this gates *what* may be asked for).
 */
export function handleSyncChannel(
  message: { channelId?: unknown; limit?: unknown },
  sendResponse: (response: { success: boolean; error?: string }) => void,
): true {
  (async () => {
    try {
      const channelId = typeof message.channelId === 'string' ? message.channelId : '';
      if (!channelId) {
        sendResponse({ success: false, error: '缺少频道 ID' });
        return;
      }
      const rawLimit = message.limit;
      const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 50)
          : 5;

      const channel = await db.channels.get(channelId);
      if (!channel) {
        sendResponse({ success: false, error: '该频道不存在或已被删除' });
        return;
      }

      // `updateChannel` does NOT throw for a failed sync — it resolves with a
      // FetchResult carrying `error` (rate limit, auth, unsupported platform).
      // Answering success without reading it would tell the popup that a
      // rate-limited fetch went fine, which is the one thing the sync layer takes
      // care to report honestly (AGENTS rule 13).
      const result = await updateChannel(channel, limit);
      if (result.error) {
        sendResponse({ success: false, error: result.error.message });
        return;
      }
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: errorMessage(e) });
    }
  })();
  // The handler answers asynchronously on every path, so the channel stays open.
  return true;
}
