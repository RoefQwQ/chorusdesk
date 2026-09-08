import type { Channel, MediaItem, Post } from '../types';

/**
 * Factory for the adapter-side Post skeleton. Every adapter built this exact
 * literal inline (13 copies) with the same six boilerplate fields — diverging
 * only in content fields. Centralizing it guarantees new platforms cannot
 * forget `fetchedAt` or store a boolean in `isRead` (AGENTS.md rule 5).
 */
export function buildPost(
  channel: Channel,
  fields: {
    id: string;
    title: string;
    content: string;
    mediaList: MediaItem[];
    originalUrl: string;
    publishedAt: number;
    isRepost?: boolean;
    channelLabel?: string;
    isBookmarked?: 0 | 1;
  }
): Post {
  return {
    id: fields.id,
    creatorId: channel.creatorId,
    channelId: channel.id,
    platform: channel.platform,
    ...(fields.channelLabel !== undefined ? { channelLabel: fields.channelLabel } : {}),
    title: fields.title,
    content: fields.content,
    mediaList: fields.mediaList,
    originalUrl: fields.originalUrl,
    publishedAt: fields.publishedAt,
    fetchedAt: Date.now(),
    isRead: 0,
    ...(fields.isBookmarked !== undefined ? { isBookmarked: fields.isBookmarked } : {}),
    ...(fields.isRepost !== undefined ? { isRepost: fields.isRepost } : {}),
  };
}
