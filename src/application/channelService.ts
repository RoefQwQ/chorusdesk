import {
  putChannel,
  updateChannelRole,
  deleteChannelCascade,
  clearStaleUpdatingStatus,
} from '../infrastructure/db/channelRepository';
import type { Channel } from '../types';

/**
 * Channel lifecycle service. Callers mutate the channel object first
 * (`accountRole` / `label`) and then call `setRole`, which persists the whole
 * record and rewrites the denormalized `channelLabel` on its posts.
 */
export const channelService = {
  /** Upsert a channel (id is `platform:accountId` — binding twice overwrites). */
  async upsert(channel: Channel): Promise<void> {
    await putChannel(channel);
  },

  /**
   * Persist an updated role/label. `channel` must already carry the new
   * `accountRole` / `label`; posts get the new label cached.
   */
  async setRole(channel: Channel): Promise<void> {
    await updateChannelRole(channel);
  },

  /** Delete a channel and every post cached under it (single tx). */
  async deleteCascade(id: string): Promise<void> {
    await deleteChannelCascade(id);
  },

  /**
   * Reset channels left in `updating` by a browser close, a crash, or an MV3
   * worker teardown. Called on dashboard boot and on popup open.
   *
   * It is a plain channel write, so it belongs here and not in `src/sync`: while
   * it lived beside `channelSync`, every caller pulled in the platform registry
   * to reset a status column — the popup was loading all ten adapters for it.
   */
  async clearStaleUpdatingStatus(): Promise<void> {
    await clearStaleUpdatingStatus();
  },
};
