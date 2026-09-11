import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The extracted readers have exactly one implementation each.
 *
 * This test exists because I got it wrong: when `xiaohongshu.ts`'s state extraction
 * moved into `profileState.ts`, I rewired only the call in `fetchLatest` and left the
 * enrichment path calling the ORIGINAL local function — so the same logic existed
 * twice, one copy reachable only through a code path my tests mocked to fail. Nine
 * green assertions said nothing about it, because they only exercised the new one.
 *
 * That is the whole hazard of an extraction: replacing one call site and not the
 * others leaves a duplicate that will drift, and the compiler cannot see it (the old
 * function is still "used"). Same class as the two hand-written placeholder-prefix
 * lists, and the same reason `hosts.singleSource.test.ts` reads source instead of
 * trusting a grep-and-hope process.
 *
 * These assertions are deliberately about *shape*, so they fail loudly if someone
 * reintroduces a local copy rather than routing through the extracted module.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('extracted readers are single-source', () => {
  it('xiaohongshu.ts keeps no local __INITIAL_STATE__ extractor', () => {
    const src = read('../src/adapters/xiaohongshu.ts');
    // A second implementation would look exactly like this.
    expect(src).not.toMatch(/__INITIAL_STATE__/);
    expect(src).not.toMatch(/__INITIAL_SSR_STATE__/);
    expect(src).not.toMatch(/function\s+extractXhsInitialState/);
    // …and it must reach the extracted one from BOTH paths (profile + enrichment).
    expect(src.match(/extractInitialState\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/from '\.\/xiaohongshu\/profileState'/);
  });

  it('bilibili.ts keeps no local space-dynamic item mapping', () => {
    const src = read('../src/adapters/bilibili.ts');
    // The mapping's fingerprints: if it is inline again, one of these reappears.
    expect(src).not.toMatch(/DYNAMIC_TYPE_FORWARD/);
    expect(src).not.toMatch(/asRecord\(major\.archive\)/);
    // Both call sites route through the extracted function.
    expect(src.match(/mapSpaceDynamicItem\(/g)?.length).toBe(2);
    expect(src).toMatch(/from '\.\/bilibili\/spaceDynamic'/);
  });

  it('no adapter writes diagnostics only to the console', () => {
    // `console` is invisible in the Developer Log panel — the surface users actually
    // screenshot into a bug report (rules 11 and 20). Three separate defects of this
    // shape were found on 2026-09-12 (a Twitter path log, bilibili's business codes,
    // xiaohongshu's parse failure), so the rule is asserted rather than remembered.
    for (const f of [
      '../src/adapters/bilibili.ts',
      '../src/adapters/douyin.ts',
      '../src/adapters/fantia.ts',
      '../src/adapters/pixiv.ts',
      '../src/adapters/rss.ts',
      '../src/adapters/twitter.ts',
      '../src/adapters/weibo.ts',
      '../src/adapters/xiaohongshu.ts',
      '../src/adapters/youtube.ts',
      '../src/adapters/xiaohongshu/profileState.ts',
      '../src/adapters/bilibili/spaceDynamic.ts',
    ]) {
      const src = read(f);
      // The injected Douyin collector is exempt by necessity: it is stringified into a
      // page with no access to the extension's logging. It is not in this list.
      expect(src, `${f} logs only to the console`).not.toMatch(/\bconsole\.(warn|error|log)\(/);
    }
  });
});
