// Real implementations: channelSync.ts / batchSync.ts / historySync.ts.
export { updateChannel } from './channelSync';
export {
  interleaveChannelsByPlatform,
  batchUpdateChannelsInterleaved,
  updateCreator,
} from './batchSync';
export {
  fetchChannelHistory,
  type DeepSyncOptions,
  deepSyncChannel,
} from './historySync';
