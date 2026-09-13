import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The background router's two lists must agree.
 *
 * `SENDER_POLICY` decides WHO may send each message type; the `if (type === …)`
 * chain decides what happens. They are maintained by hand, and each way of
 * disagreeing fails silently:
 *
 *  - **In the policy table, no handler branch** — the message passes the sender
 *    gate and then falls through to `return false`. The caller's `sendResponse`
 *    is never invoked, so the popup/adapter waits on a callback that never fires.
 *  - **A handler branch with no policy entry** — `policy` is `undefined`, so
 *    `allowed` is false and the message is REFUSED for every sender, including the
 *    dashboard. The feature looks implemented and answers 「请求来源不受信任」.
 *
 * Neither is caught by typecheck, and neither shows up until the feature is used.
 * This is the cheap half of queue #16: the full MessageMap (typed request/response
 * per type, one source for the sender, the handler and the caller) is recorded as
 * long-term work, but the invariant it protects can be pinned now.
 *
 * Read from the source because `SENDER_POLICY` is module-local and the router is
 * registered inside `defineBackground` — same technique as
 * `tests/workflows.gateParity.test.ts`.
 */

const src = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

/** The policy table's keys. */
function policyTypes(): string[] {
  const table = src.slice(src.indexOf('const SENDER_POLICY'));
  const body = table.slice(0, table.indexOf('};'));
  return [...body.matchAll(/^\s{2}([A-Z_]+):\s*'page',/gm)].map((m) => m[1]);
}

/** The types the router actually dispatches. */
function handledTypes(): string[] {
  const router = src.slice(src.indexOf('chrome.runtime.onMessage.addListener'));
  return [...router.matchAll(/if \(type === '([A-Z_]+)'\)/g)].map((m) => m[1]);
}

describe('background message router', () => {
  it('parsed both lists', () => {
    // Without this, a rewrite of either shape would make the checks below pass by
    // finding nothing at all.
    expect(policyTypes().length, 'no SENDER_POLICY entries parsed').toBeGreaterThan(3);
    expect(handledTypes().length, 'no dispatch branches parsed').toBeGreaterThan(3);
  });

  it('every policy entry has a handler branch', () => {
    const handled = new Set(handledTypes());
    const orphaned = policyTypes().filter((t) => !handled.has(t));
    expect(
      orphaned,
      `these types pass the sender gate and then fall through to \`return false\`, ` +
        `so sendResponse is never called: ${orphaned.join(', ')}`,
    ).toEqual([]);
  });

  it('every handler branch has a policy entry', () => {
    const policy = new Set(policyTypes());
    const unguarded = handledTypes().filter((t) => !policy.has(t));
    expect(
      unguarded,
      `these types have a handler but no SENDER_POLICY entry, so they are refused ` +
        `for every sender: ${unguarded.join(', ')}`,
    ).toEqual([]);
  });

  it('refuses an absent policy rather than defaulting to allowed', () => {
    // The fail-closed default is a security property, not an implementation
    // detail: `policy === 'page' ? isExtensionPageSender(...) : false`.
    expect(src).toMatch(/policy === 'page'\s*\?\s*isExtensionPageSender\(sender\)\s*:\s*false/);
  });

  it('every privileged handler is reached through a validated sender', () => {
    // AGENTS rule 4: the guard lives in the router, so no handler may be invoked
    // outside the `onMessage` listener that applies it.
    const privileged = ['handleBgFetch', 'handleProxyImage', 'handleSyncChannel', 'handleTwitterTimeline', 'handleDouyinSnapshot'];
    for (const handler of privileged) {
      const calls = [...src.matchAll(new RegExp(`${handler}\\(`, 'g'))];
      // One import line's use plus the dispatch; the import itself does not call.
      expect(calls.length, `${handler} is never dispatched`).toBeGreaterThan(0);
    }
  });
});
