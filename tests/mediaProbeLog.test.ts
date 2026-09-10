import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The developer log is what the user reads and pastes when reporting a problem,
 * so its signal-to-noise ratio is a feature, not cosmetics.
 *
 * Measured on a real session before this existed: 102 of 150 log lines (68%) were
 * the per-card `磁盘探测` line, arriving in bursts of 72 and 26 as the feed was
 * scrolled — around 11 lines that actually said what happened. Cards probe in
 * bursts because a render or a scroll brings many into the observer's margin at
 * once, which is what makes summing over a quiet period the right shape.
 */

const logged: Array<{ level: string; message: string; detail?: string }> = [];

vi.mock('../src/utils/devLog', () => ({
  devLog: {
    debug: (_scope: string, message: string, detail?: string) =>
      logged.push({ level: 'debug', message, detail }),
    warn: (_scope: string, message: string, detail?: string) =>
      logged.push({ level: 'warn', message, detail }),
    info: () => {},
    error: () => {},
  },
}));

const { flushMediaProbeLog, recordMediaProbe, resetMediaProbeLog } = await import(
  '../src/utils/mediaProbeLog'
);

beforeEach(() => {
  logged.length = 0;
  resetMediaProbeLog();
  vi.useFakeTimers();
});

afterEach(() => {
  resetMediaProbeLog();
  vi.useRealTimers();
});

/** Let the quiet period elapse. */
function settle(): void {
  vi.advanceTimersByTime(1_100);
}

describe('recordMediaProbe', () => {
  it('sums a burst into one line instead of one line per card', () => {
    // The regression, stated as the user experienced it: scrolling the feed
    // produced ~100 lines of per-card telemetry.
    for (let i = 0; i < 72; i++) recordMediaProbe(1, 1, 4, 'twitter');
    settle();

    expect(logged).toHaveLength(1);
  });

  it('keeps every fact the per-card line carried', () => {
    recordMediaProbe(1, 1, 4, 'twitter');
    recordMediaProbe(2, 0, 6, 'rss');
    recordMediaProbe(4, 4, 5, 'bilibili');
    settle();

    const line = logged[0];
    // Cards, and how many of their images were already on disk.
    expect(line.message).toContain('3 张卡片');
    expect(line.message).toContain('命中 5/7');
    expect(line.message).toContain('最慢 6ms');
    expect(line.level).toBe('debug');
  });

  it('does not drop anything: an interleaved burst still sums exactly', () => {
    // Summing, not sampling. A rate-limited logger would lose the slow card.
    for (let i = 0; i < 30; i++) recordMediaProbe(3, 1, 20);
    settle();

    expect(logged[0].message).toContain('30 张卡片');
    expect(logged[0].message).toContain('命中 30/90');
  });
});

describe('recordMediaProbe — slow probes', () => {
  it('surfaces a slow cache once, at warn level', () => {
    // A card over the threshold means the session caches in `fsManager` are not
    // doing their job. Reported once per burst, not once per card — reporting it
    // per card is how the original warning became part of the noise.
    for (let i = 0; i < 10; i++) recordMediaProbe(1, 0, 3_000, 'xiaohongshu');
    settle();

    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe('warn');
    expect(logged[0].message).toContain('10 张超过 1500ms');
    expect(logged[0].message).toContain('最慢 3000ms');
  });

  it('names the platform of the slowest card', () => {
    // Aggregate counts alone would not say where to look.
    recordMediaProbe(1, 0, 1_800, 'weibo');
    recordMediaProbe(1, 0, 4_200, 'rss');
    settle();

    expect(logged[0].detail).toBe('平台 rss');
  });

  it('stays at debug when only some cards are slow but none exceed', () => {
    recordMediaProbe(1, 1, 1_499);
    recordMediaProbe(1, 1, 10);
    settle();

    expect(logged[0].level).toBe('debug');
    expect(logged[0].message).not.toContain('超过');
  });

  it('counts only the cards over the threshold', () => {
    recordMediaProbe(1, 1, 10);
    recordMediaProbe(1, 1, 2_000);
    recordMediaProbe(1, 1, 20);
    settle();

    expect(logged[0].message).toContain('1 张超过');
  });
});

describe('recordMediaProbe — batching windows', () => {
  it('starts a new line after a quiet period, so bursts stay separate', () => {
    // Two scroll bursts minutes apart should read as two events, not one line
    // with the totals blended together.
    recordMediaProbe(1, 1, 4);
    settle();
    recordMediaProbe(1, 0, 9);
    settle();

    expect(logged).toHaveLength(2);
    expect(logged[0].message).toContain('命中 1/1');
    expect(logged[1].message).toContain('命中 0/1');
  });

  it('keeps accumulating while probes keep arriving', () => {
    // A quiet period has to actually be quiet: a burst that arrives faster than
    // the window must not be split into many lines.
    for (let i = 0; i < 20; i++) {
      recordMediaProbe(1, 1, 3);
      vi.advanceTimersByTime(50);
    }
    settle();

    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('20 张卡片');
  });

  it('emits nothing when nothing was probed', () => {
    settle();
    expect(logged).toHaveLength(0);
  });
});

describe('flushMediaProbeLog', () => {
  it('emits immediately, without waiting for the quiet period', () => {
    recordMediaProbe(2, 2, 5, 'youtube');

    flushMediaProbeLog();

    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('1 张卡片');
  });

  it('is idempotent: a second call has nothing left to emit', () => {
    recordMediaProbe(1, 1, 5);
    flushMediaProbeLog();
    flushMediaProbeLog();

    expect(logged).toHaveLength(1);
  });

  it('does not double-emit when the quiet period then elapses', () => {
    // The flush clears the pending timer; leaving it armed would emit the same
    // batch a second time.
    recordMediaProbe(1, 1, 5);
    flushMediaProbeLog();
    settle();

    expect(logged).toHaveLength(1);
  });

  it('is a no-op when nothing is pending', () => {
    flushMediaProbeLog();
    expect(logged).toHaveLength(0);
  });
});
