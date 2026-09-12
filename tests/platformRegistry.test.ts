import { describe, expect, it } from 'vitest';
import { PLATFORM_REGISTRY, KNOWN_PLATFORMS, isKnownPlatform, type KnownPlatform } from '../src/types';
import { getAdapter } from '../src/platform/registry';

/**
 * The registry keys and the known-platform set must not drift (audit P1-12).
 *
 * `Platform` includes `(string & {})` so stored data stays open — a channel
 * bound before Withny was removed still carries `platform: 'withny'`. The cost
 * of that openness is that a `switch`/`Record` over `Platform` can never be
 * proven complete, which is how "adding a platform" stayed a manual checklist.
 * `KnownPlatform` restores the closed set for decisions about our own
 * behaviour; these assertions are what keep the two in step.
 */
describe('KnownPlatform is the closed set the registry is keyed by', () => {
  it('every known platform has both a registry entry and an adapter', () => {
    for (const platform of KNOWN_PLATFORMS) {
      expect(PLATFORM_REGISTRY[platform], `PLATFORM_REGISTRY is missing ${platform}`).toBeDefined();
      expect(getAdapter(platform), `no adapter registered for ${platform}`).toBeDefined();
    }
  });

  it('the adapter registry has no key the known set does not declare', () => {
    // A platform present in the registry but absent from KNOWN_PLATFORMS would
    // be reachable by URL parsing while invisible to every exhaustive check.
    for (const key of Object.keys(PLATFORM_REGISTRY)) {
      expect(KNOWN_PLATFORMS as readonly string[]).toContain(key);
    }
  });

  it('an unknown platform is unregistered, so it reports unsupported rather than falling back', () => {
    // The legacy key from the removed Withny platform: still storable, never
    // silently served by another adapter (AGENTS rule 8 / channelSync's contract).
    expect(isKnownPlatform('withny')).toBe(false);
    expect(getAdapter('withny')).toBeUndefined();
  });

  it('narrows only the declared members', () => {
    expect(isKnownPlatform('bilibili')).toBe(true);
    expect(isKnownPlatform('rss')).toBe(true);
    expect(isKnownPlatform('anything-else')).toBe(false);
    // The type-level half: assigning a known member is fine; the point of the
    // union is that this list can be exhaustively switched over.
    const exhaustive = (p: KnownPlatform): string => p;
    expect(exhaustive('douyin')).toBe('douyin');
  });
});
