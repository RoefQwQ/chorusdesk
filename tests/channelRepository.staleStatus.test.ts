import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';

/**
 * `clearStaleUpdatingStatus` is the startup recovery for a sync that was killed
 * mid-flight — the browser was closed, or the MV3 worker was torn down while a
 * channel was marked `updating`. It is awaited on dashboard boot, on popup open,
 * and by the two sync entry points.
 *
 * It lives in the db layer (moved out of `src/sync/channelSync.ts` on 2026-09-11,
 * queue item B20). The behaviour did not change, but why it needs pinning did:
 * while it sat beside `channelSync`, every caller — the popup included — pulled in
 * the platform registry to reset a status column.
 *
 * The contract has two halves and both are worth pinning, because each has a
 * plausible way to be broken by an innocuous-looking edit:
 *
 *  - it resets exactly the rows whose status is `updating`, and nothing else. A
 *    "simplification" to a filter on the fetched rows, or dropping the index
 *    predicate, would silently reset channels that had genuinely failed — and
 *    `errorMessage` is the user's only explanation for a red badge, so losing it
 *    turns a diagnosable failure into an unexplained one;
 *  - it never throws. It runs during dashboard boot, so a rejection here would
 *    take out the whole shell to recover from a condition that is merely cosmetic.
 */

type Row = Channel & { errorMessage?: string };

const seed: Row[] = [];
let failNextQuery = false;

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    channels: {
      where: (_index: string) => ({
        equals: (value: unknown) => ({
          modify: async (changes: Record<string, unknown>) => {
            if (failNextQuery) throw new Error('indexedDB is gone');
            let count = 0;
            for (const row of seed) {
              if (row.status !== value) continue;
              Object.assign(row, changes);
              count++;
            }
            return count;
          },
        }),
      }),
    },
  },
}));

import { clearStaleUpdatingStatus } from '../src/infrastructure/db/channelRepository';

const row = (id: string, status: Channel['status'], extra: Partial<Row> = {}): Row => ({
  id,
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: 'a_' + id,
  displayName: '昵称_' + id,
  status,
  profileUrl: 'https://example.com/' + id,
  ...extra,
});

const byId = (id: string) => seed.find((r) => r.id === id)!;

beforeEach(() => {
  seed.length = 0;
  failNextQuery = false;
  vi.clearAllMocks();
});

describe('clearStaleUpdatingStatus', () => {
  it('resets every channel left mid-sync, and only those', async () => {
    seed.push(
      row('c-updating-1', 'updating'),
      row('c-updating-2', 'updating'),
      row('c-idle', 'idle'),
      row('c-success', 'success'),
      row('c-error', 'error', { errorMessage: '429 请求过于频繁' }),
    );

    await clearStaleUpdatingStatus();

    expect(byId('c-updating-1').status).toBe('idle');
    expect(byId('c-updating-2').status).toBe('idle');
    expect(byId('c-idle').status).toBe('idle');
    expect(byId('c-success').status).toBe('success');
  });

  it('leaves a failed channel failed, with its message', async () => {
    seed.push(row('c-error', 'error', { errorMessage: '429 请求过于频繁' }));

    await clearStaleUpdatingStatus();

    expect(byId('c-error').status).toBe('error');
    // The red badge's only explanation. Resetting it would hide a real failure.
    expect(byId('c-error').errorMessage).toBe('429 请求过于频繁');
  });

  it('does not reject when the query throws', async () => {
    // The dashboard awaits this during boot. AGENTS rule 13: an empty or broken
    // result is not an error the user can act on here — the recovery is cosmetic.
    seed.push(row('c-updating', 'updating'));
    failNextQuery = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(clearStaleUpdatingStatus()).resolves.toBeUndefined();

    warn.mockRestore();
  });
});
