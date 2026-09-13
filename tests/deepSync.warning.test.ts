import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeDialog, resetDialogs, settleDialog } from '../entrypoints/dashboard/composables/useDialog';
import type { Channel, Creator } from '../src/types';

/**
 * The warning shown before a dig that scrolls the user's own logged-in page.
 *
 * The cost of that acquisition is paid by the user's ACCOUNT, not by us: the
 * platform's anti-bot heuristics watch for a page being scrolled programmatically,
 * and the reference implementation for the one such platform ships the same
 * behaviour **off by default, behind a risk warning**. So the user is told before
 * it runs, not after something goes wrong.
 *
 * The flag driving this is the adapter's own declaration (`digScrollsUserPage`),
 * never a platform name at the call site (rule 2's shape): a future page-driven
 * platform inherits the warning by declaring the fact once. The default is `false`
 * — a confirmation nobody's platform asked for is noise, and noise is how a real
 * warning gets dismissed without being read.
 *
 * Asserted on what the USER observes: a dialog appears naming the platform, and
 * declining it stops the dig from starting at all.
 */

// `vi.hoisted` because the `vi.mock` factory is lifted above every other
// statement, so a plain `const` would still be uninitialised when it runs.
const { deepSyncChannel } = vi.hoisted(() => ({
  deepSyncChannel: vi.fn(async (_ch: unknown, _opts: unknown) => ({ totalNew: 0, reachEnd: false, rounds: 0 })),
}));
vi.mock('../src/sync', async () => {
  const actual = await vi.importActual<typeof import('../src/sync')>('../src/sync');
  return { ...actual, deepSyncChannel };
});

import { useDeepSync } from '../entrypoints/dashboard/composables/useDeepSync';

const creator = { id: 'c1', name: '示例博主' } as Creator;

const channelOf = (platform: string, id = '1'): Channel => ({
  id: `${platform}:${id}`,
  creatorId: 'c1',
  platform: platform as Channel['platform'],
  accountId: '63799a52000000001f01ca92',
  displayName: '示例账号',
  status: 'idle',
  profileUrl: 'https://example.com/',
});

function setup(channels: Channel[]) {
  const composer = useDeepSync({
    getChannels: () => channels,
    reloadData: async () => {},
  });
  composer.openDeepSyncModal(creator);
  return composer;
}

const request = (channelIds: string[]) => ({
  channelIds,
  mode: 'count' as const,
  targetCount: 50,
  timeRange: 0,
  onlyOriginal: false,
  resetCursor: false,
});

describe('deep-sync warning for a page-scrolling dig', () => {
  beforeEach(() => {
    resetDialogs();
    deepSyncChannel.mockClear();
  });

  it('warns before scrolling a xiaohongshu account, and names the platform', async () => {
    const ch = channelOf('xiaohongshu');
    const composer = setup([ch]);

    const started = composer.startDeepSync(request([ch.id]));

    // The dialog is up before any acquisition: the dig has not been dispatched.
    expect(activeDialog.value?.kind).toBe('confirm');
    expect(activeDialog.value?.message).toContain('小红书');
    expect(deepSyncChannel).not.toHaveBeenCalled();

    settleDialog(activeDialog.value!.id, true);
    await started;
    expect(deepSyncChannel).toHaveBeenCalledTimes(1);
  });

  it('does not start the dig when the warning is declined', async () => {
    const ch = channelOf('xiaohongshu');
    const composer = setup([ch]);

    const started = composer.startDeepSync(request([ch.id]));
    settleDialog(activeDialog.value!.id, false);
    await started;

    expect(deepSyncChannel).not.toHaveBeenCalled();
    expect(composer.isDeepSyncRunning.value).toBe(false);
  });

  it('says plainly when several risky accounts would be dug at once', async () => {
    const channels = ['a', 'b', 'c'].map((id) => channelOf('xiaohongshu', id));
    const composer = setup(channels);

    const started = composer.startDeepSync(request(channels.map((c) => c.id)));

    // The count and the compounding risk are stated, not left for the user to infer.
    expect(activeDialog.value?.message).toContain('3');
    expect(activeDialog.value?.message).toContain('风控');

    settleDialog(activeDialog.value!.id, false);
    await started;
  });

  it('does not warn for a platform whose dig touches no user page', async () => {
    // bilibili walks a real cursor over its own API: no page of the user's is
    // driven, so a warning here would be noise.
    const ch = channelOf('bilibili');
    const composer = setup([ch]);

    await composer.startDeepSync(request([ch.id]));

    expect(activeDialog.value).toBeNull();
    expect(deepSyncChannel).toHaveBeenCalledTimes(1);
  });

  it('warns only about the risky platforms in a mixed selection', async () => {
    const risky = channelOf('xiaohongshu', 'x');
    const safe = channelOf('bilibili', 'b');
    const composer = setup([risky, safe]);

    const started = composer.startDeepSync(request([risky.id, safe.id]));

    // One account is the ordinary case: a plain confirmation, not the severe one.
    expect(activeDialog.value?.message).toContain('小红书');
    expect(activeDialog.value?.title).toBe('回溯前的提醒');

    settleDialog(activeDialog.value!.id, true);
    await started;
    // Both channels were still dug after confirming.
    expect(deepSyncChannel).toHaveBeenCalledTimes(2);
  });
});
