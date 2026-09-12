import { describe, expect, it } from 'vitest';
import { toEpochMs, toEpochMsOr } from '../src/utils/timestamp';

/**
 * The timestamp contract (audit P2-4 / P2-19).
 *
 * `Post.publishedAt` is Epoch ms, but adapters emit seconds for some platforms,
 * so four call sites each grew their own `timestamp < 1e12 ? * 1000 : timestamp`
 * guess. A heuristic copy-pasted to every display site is a contract that does
 * not exist — the point of one implementation is that the guess is now testable
 * and the boundary behavior is decided once.
 *
 * The cases that matter are the boundary itself (a value either side of 1e12)
 * and the absent value, because `new Date(NaN)` renders as "Invalid Date" and
 * `new Date(0)` renders as 1970 — both read as real data.
 */
describe('toEpochMs', () => {
  it('leaves a millisecond timestamp alone', () => {
    // 2023-11-14T22:13:20Z, and any modern ms value is far above the threshold.
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('scales a second timestamp up', () => {
    expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('treats the threshold as milliseconds', () => {
    // A value exactly at 1e12 is already ms (2001-09-09 in ms terms), so it must
    // not be multiplied again — the off-by-one the hand-rolled sites could each
    // get wrong independently.
    expect(toEpochMs(1e12)).toBe(1e12);
    expect(toEpochMs(1e12 - 1)).toBe((1e12 - 1) * 1000);
  });

  it('returns null for absent, non-finite and non-positive values', () => {
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(NaN)).toBeNull();
    expect(toEpochMs(Infinity)).toBeNull();
    // 0 / negative is not a publish time; fabricating 1970 would render as a
    // plausible-but-wrong date instead of "未知时间".
    expect(toEpochMs(0)).toBeNull();
    expect(toEpochMs(-1)).toBeNull();
  });

  it('toEpochMsOr substitutes only when a real value is missing', () => {
    expect(toEpochMsOr(1_700_000_000, 42)).toBe(1_700_000_000_000);
    expect(toEpochMsOr(undefined, 42)).toBe(42);
    expect(toEpochMsOr(0, 42)).toBe(42);
  });
});
