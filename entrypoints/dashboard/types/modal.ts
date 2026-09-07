import type { Channel, Creator } from '../../../src/types';

export type AddModalRole = 'main' | 'sub' | 'alt' | 'custom';

export interface AddModalOpenRequest {
  mode: 'new' | 'channel';
  creator: Creator | null;
  initialUrl: string;
}

export interface AddModalSubmitPayload {
  mode: 'new' | 'channel';
  url: string;
  creatorId: string;
  name: string;
  tags: string;
  role: AddModalRole;
  customLabel: string;
}

export interface DeepSyncStartRequest {
  channelIds: string[];
  mode: 'count' | 'time';
  targetCount: number;
  timeRange: number;
  onlyOriginal: boolean;
  resetCursor: boolean;
}

export type { Channel, Creator };
