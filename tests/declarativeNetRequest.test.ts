import { describe, expect, it, vi } from 'vitest';
import {
  MEDIA_HEADER_RULES,
  buildRules,
  ruleIds,
  setupDeclarativeNetRules,
} from '../src/infrastructure/chrome/declarativeNetRequest';

/**
 * The DNR rules had no test at all, and two things about them are load-bearing:
 *
 *  - **Every rule is scoped to this extension.** `initiatorDomains: [runtime.id]`
 *    is what keeps our Referer rewrite off the user's other tabs. Without it the
 *    rules matched any page embedding an sinaimg/xhscdn image and silently
 *    degraded that page's loading. That was written as prose in the module header
 *    and per-rule in six separate `condition` objects, so nothing could fail when
 *    a seventh rule forgot it.
 *  - **The ids were written twice** — once per rule body, once in `removeRuleIds`.
 *    An id edited in one place only means the removal misses and the rule
 *    accumulates across restarts, with no symptom until the ids collide.
 *
 * Both are now structural: rules come from one table, and the ids derive from it.
 */

describe('media header rules', () => {
  it('scopes EVERY rule to this extension', () => {
    // The one property that a new rule is most likely to omit.
    const rules = buildRules('test-extension-id');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.condition?.initiatorDomains, `rule ${rule.id} is not scoped`).toEqual([
        'test-extension-id',
      ]);
    }
  });

  it('does not widen the match to sub-frames or other resource types', () => {
    // `sub_frame` was dropped on purpose: an embedded frame is not our request.
    for (const rule of buildRules('x')) {
      const types = rule.condition?.resourceTypes ?? [];
      expect(types, `rule ${rule.id} includes sub_frame`).not.toContain('sub_frame');
      expect(types.length, `rule ${rule.id} has no resource types`).toBeGreaterThan(0);
    }
  });

  it('derives removeRuleIds from the same table as the rules', () => {
    // The two lists cannot disagree, which is what the hand-written pair allowed.
    const rules = buildRules('x');
    expect(ruleIds()).toEqual(rules.map((r) => r.id));
    expect(ruleIds()).toEqual(MEDIA_HEADER_RULES.map((r) => r.id));
  });

  it('keeps ids unique and in the documented range', () => {
    const ids = ruleIds();
    expect(new Set(ids).size, `duplicate ids: ${JSON.stringify(ids)}`).toBe(ids.length);
    // Dynamic rule ids must be positive; ours are the 1001+ block so they are
    // never confused with a session rule.
    for (const id of ids) {
      expect(Number.isInteger(id) && id > 0, `bad id ${id}`).toBe(true);
      expect(id).toBeGreaterThanOrEqual(1001);
    }
  });

  it('every rule actually does something', () => {
    // A rule with neither a header nor a scheme upgrade is inert: Chrome accepts
    // it, it matches requests, and it changes nothing.
    for (const rule of buildRules('x')) {
      const isUpgrade = rule.action?.type === 'upgradeScheme';
      const headerCount = rule.action?.requestHeaders?.length ?? 0;
      expect(
        isUpgrade || headerCount > 0,
        `rule ${rule.id} neither upgrades the scheme nor sets a header`,
      ).toBe(true);
    }
  });

  it('sets a Referer on every header-rewriting rule', () => {
    // The Referer is the whole point of the hotlink bypasses; a rule that sets
    // only Origin would look configured and fetch nothing.
    for (const rule of buildRules('x')) {
      if (rule.action?.type === 'upgradeScheme') continue;
      const headers = (rule.action?.requestHeaders ?? []).map((h) => h.header);
      expect(headers, `rule ${rule.id} sets no Referer`).toContain('Referer');
    }
  });

  it('writes the URL filter the browser matches, not a parsed host', () => {
    // DNR evaluates `urlFilter` against the full request URL; these are substring
    // patterns, so a rule whose filter lost its leading wildcard would only match
    // a URL that starts with the host.
    for (const rule of buildRules('x')) {
      const filter = String(rule.condition?.urlFilter ?? '');
      expect(filter.length, `rule ${rule.id} has an empty urlFilter`).toBeGreaterThan(0);
      if (!filter.startsWith('http')) {
        expect(filter.startsWith('*'), `rule ${rule.id} filter "${filter}" is not a substring pattern`).toBe(true);
      }
    }
  });
});

describe('setupDeclarativeNetRules', () => {
  function withChrome(updateDynamicRules: (arg: unknown) => Promise<void>) {
    const calls: unknown[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: 'ext-id' },
      declarativeNetRequest: {
        updateDynamicRules: async (arg: unknown) => {
          calls.push(arg);
          await updateDynamicRules(arg);
        },
      },
    };
    return calls;
  }

  it('removes before adding, with the ids it is about to add', async () => {
    const calls = withChrome(async () => {});
    await setupDeclarativeNetRules();

    expect(calls).toHaveLength(1);
    const arg = calls[0] as { removeRuleIds: number[]; addRules: Array<{ id: number; condition: { initiatorDomains: string[] } }> };
    expect(arg.removeRuleIds).toEqual(ruleIds());
    expect(arg.addRules.map((r) => r.id)).toEqual(ruleIds());
    expect(arg.addRules.every((r) => r.condition.initiatorDomains[0] === 'ext-id')).toBe(true);
  });

  it('is a no-op where the API is absent, rather than throwing', async () => {
    // The dashboard and the unit-test environment have no `chrome.*`; this runs
    // from `defineBackground` on several events, so a throw here would be noise.
    (globalThis as { chrome?: unknown }).chrome = undefined as unknown;
    await expect(setupDeclarativeNetRules()).resolves.toBeUndefined();
  });

  it('swallows an API failure instead of breaking the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withChrome(async () => {
      throw new Error('quota exceeded');
    });
    await expect(setupDeclarativeNetRules()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    delete (globalThis as { chrome?: unknown }).chrome;
  });
});
