import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Creator, Post } from '../src/types';
import { GENERATED_NAME_PREFIXES } from '../src/utils/urlParser';

/**
 * Name provenance (audit P1-5, AGENTS rule 9).
 *
 * The sync layer may overwrite a display name only when WE generated it. The old
 * way of deciding that was a hand-written list of every `urlParser` placeholder
 * prefix, and it drifted twice — Withny for its whole lifetime, then eight
 * prefixes at once — with no failure signal, because a missing prefix just pins
 * a machine name forever.
 *
 * `nameSource` replaces the guess with a fact. The cases below pin the three
 * directions that matter: a generated name IS replaced, a user's name is NOT,
 * and a legacy row (no `nameSource`) is repaired exactly once.
 */

const channels = new Map<string, Channel>();
const creators = new Map<string, Creator>();
const channelUpdates: Array<Record<string, unknown>> = [];
const creatorUpdates: Array<{ id: string; changes: Record<string, unknown> }> = [];

vi.mock('../src/platform/registry', () => ({
  getAdapter: () => ({
    platform: 'bilibili',
    fetchLatest: async () => ({
      posts: [] as Post[],
      hasMore: false,
      authorMeta: { name: '平台真实昵称' },
    }),
  }),
}));

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    posts: {
      where: () => ({
        between: () => ({ last: async () => null }),
        equals: () => ({ primaryKeys: async () => [], each: async () => {} }),
      }),
      bulkGet: async () => [],
      bulkPut: async () => {},
      bulkDelete: async () => {},
      each: async () => {},
    },
    channels: {
      get: vi.fn(async (id: string) => channels.get(id)),
      update: vi.fn(async (id: string, changes: Record<string, unknown>) => {
        channelUpdates.push(changes);
        const existing = channels.get(id);
        if (existing) channels.set(id, { ...existing, ...changes } as Channel);
      }),
    },
    creators: {
      get: vi.fn(async (id: string) => creators.get(id)),
      update: vi.fn(async (id: string, changes: Record<string, unknown>) => {
        creatorUpdates.push({ id, changes });
        const existing = creators.get(id);
        if (existing) creators.set(id, { ...existing, ...changes } as Creator);
      }),
    },
    postSuppressions: {
      bulkGet: async (ids: string[]) => ids.map(() => undefined),
      bulkDelete: async () => {},
    },
  },
}));

import { updateChannel } from '../src/sync/channelSync';

function seed(name: string, nameSource?: Channel['nameSource']) {
  channels.clear();
  creators.clear();
  channelUpdates.length = 0;
  creatorUpdates.length = 0;
  const channel: Channel = {
    id: 'bilibili:names',
    creatorId: 'c1',
    platform: 'bilibili',
    accountId: 'names',
    displayName: name,
    ...(nameSource === undefined ? {} : { nameSource }),
    status: 'idle',
    profileUrl: 'https://space.bilibili.com/names',
  };
  channels.set(channel.id, channel);
  creators.set('c1', {
    id: 'c1',
    name,
    ...(nameSource === undefined ? {} : { nameSource }),
    avatar: '',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  });
  return channel;
}

beforeEach(() => {
  channels.clear();
  creators.clear();
  channelUpdates.length = 0;
  creatorUpdates.length = 0;
});

describe('display-name provenance', () => {
  it('replaces a name we generated, and stamps the write as platform-sourced', async () => {
    const channel = seed('B站用户_123456', 'generated');
    await updateChannel(channel, 10, false);

    expect(channelUpdates.find((u) => u.displayName)?.displayName).toBe('平台真实昵称');
    expect(channelUpdates.find((u) => u.displayName)?.nameSource).toBe('platform');
    // The creator name follows the same rule.
    expect(creatorUpdates.find((u) => u.changes.name)?.changes.name).toBe('平台真实昵称');
    expect(creatorUpdates.find((u) => u.changes.name)?.changes.nameSource).toBe('platform');
  });

  it('NEVER overwrites a user-set name, even when it looks generated', async () => {
    // The exact false positive the prefix heuristic produced: a person who wants
    // their channel called this. `generated` is false, so the platform's
    // nickname must not win.
    const channel = seed('Pixiv作品_集', 'user');
    await updateChannel(channel, 10, false);

    expect(channelUpdates.some((u) => u.displayName !== undefined)).toBe(false);
    expect(creatorUpdates.some((u) => u.changes.name !== undefined)).toBe(false);
  });

  it('leaves a name the platform already supplied alone', async () => {
    const channel = seed('已经是平台昵称', 'platform');
    await updateChannel(channel, 10, false);

    expect(channelUpdates.some((u) => u.displayName !== undefined)).toBe(false);
  });

  it('repairs a legacy row (no nameSource) once, then never consults the heuristic again', async () => {
    // A row written before `nameSource` existed still carries a generated name.
    const channel = seed('小红书笔记_abc123');

    await updateChannel(channel, 10, false);

    expect(channelUpdates.find((u) => u.displayName)?.displayName).toBe('平台真实昵称');
    expect(channelUpdates.find((u) => u.displayName)?.nameSource).toBe('platform');

    // Second sync: the stored row now says `platform`, so the name is stable —
    // the heuristic ran exactly once and the row graduated out of it.
    channelUpdates.length = 0;
    const updated = channels.get('bilibili:names')!;
    await updateChannel(updated, 10, false);
    expect(channelUpdates.some((u) => u.displayName !== undefined)).toBe(false);
  });

  it('a legacy row with a genuine user name is still repaired (the documented one-time cost)', async () => {
    // Honest about the boundary: a pre-`nameSource` row whose name merely LOOKS
    // generated cannot be distinguished from a real placeholder, so it is
    // replaced once. This is bounded — the stamp makes it non-recurring — and is
    // the price of having had no provenance field.
    const channel = seed('B站用户_这不是占位名');

    await updateChannel(channel, 10, false);

    expect(channelUpdates.find((u) => u.displayName)?.displayName).toBe('平台真实昵称');
  });

  it('the replacement prefixes come from urlParser, so a new platform cannot be forgotten', () => {
    // The list is the single source; `channelSync` derives from it. A non-empty
    // list with the capitalisation quirks that caused the original drift.
    expect(GENERATED_NAME_PREFIXES.length).toBeGreaterThan(0);
    expect(GENERATED_NAME_PREFIXES).toContain('YouTube视频_');
    expect(GENERATED_NAME_PREFIXES).toContain('RSS_');
  });
});
