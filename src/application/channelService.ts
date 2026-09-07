import { putChannel, updateChannelRole, deleteChannelCascade } from '../infrastructure/db/channelRepository';
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
};
