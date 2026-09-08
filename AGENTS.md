# AGENTS.md — Chorus / creator-feed-hub

Binding constraints for anyone (human or agent) editing this repo. Reusable rules only.
One-off review output lives in `docs/REVIEW_2026-09.md` — do not copy it here.

Stack: WXT 0.21 + Vue 3 + Dexie 4 + Tailwind 4, TypeScript strict, Chrome MV3.
Commands: `npm run dev` / `build` / `zip`. No test runner or linter exists yet (see fix queue #12).

---

## 1. Host identity: NEVER match a host with a substring

`url.includes('rplay.live')` also matches `https://evil.example/?ref=rplay.live` and
`https://rplay.live.attacker.tld/`. Any decision that gates **credentials, tokens, cookies, or
header injection** MUST parse the URL and match the hostname:

```ts
import { hostMatches, isPlatformHost, parseFetchableUrl } from '@/infrastructure/chrome/messages/hosts';

const parsed = parseFetchableUrl(rawUrl);        // rejects non-http(s) + embedded credentials
if (!parsed) return;
if (hostMatches(parsed.hostname, 'rplay.live')) { /* subdomain-safe */ }
```

This was the root cause of the 2026-09 BLOCKER: `bgFetch` injected the stored Rplay bearer token
on a substring test while `proxyImage` already did it correctly. **The two handlers diverged once
already** — treat this as a recurring failure mode, not a one-off.

Substring tests are acceptable only for non-security cosmetics (labels, icons).

## 2. `hosts.ts` is the single source of truth for platform hosts

`src/infrastructure/chrome/messages/hosts.ts` (`PLATFORM_HOSTS`) is the only allowlist.
Adding a platform means updating **both**:

1. `PLATFORM_HOSTS` in `hosts.ts`
2. `host_permissions` in `wxt.config.ts`

Never inline a second host list in a handler, adapter, or composable. Existing duplication that
still violates this (two cookie-auth tables, `proxyImage`'s own regex) is queued at #10 — do not
add to it.

## 3. The allowlist governs CREDENTIALS, not reachability

Non-obvious and easy to "helpfully" break: `src/adapters/rss.ts` fetches **arbitrary user-entered
feed URLs**. A hard host allowlist on *reachability* would silently kill all third-party/self-hosted
RSS.

The rule is therefore:

| Request host | credentials |
|---|---|
| in `PLATFORM_HOSTS` | `'include'` |
| anything else | `'omit'` |

Any host may be *fetched*; only known platforms may carry the user's session. Do not convert this
into a reachability allowlist.

## 4. Privileged message handlers MUST validate the sender

`chrome.runtime.onMessage` fires for extension pages, our content scripts, and — if
`externally_connectable` is ever declared — arbitrary web pages and other extensions. Do not rely on
that manifest default for safety.

Sender policy is enforced **centrally in the router** (`entrypoints/background.ts`) via
`src/infrastructure/chrome/messages/senderGuard.ts`; handlers stay pure and assume trust:

- `isExtensionPageSender` — dashboard/popup only. Required for anything that fetches with cookies,
  reads stored tokens, or returns a response body (`BG_FETCH`, `PROXY_IMAGE`,
  `FETCH_TWITTER_TIMELINE`, `SYNC_RPLAY_TOKEN`).
- `isContentScriptSenderOn(sender, 'rplay.live')` — the token relay, which legitimately originates
  from a content script.

New message type ⇒ add it to the router's policy table. No exceptions, no per-handler ad-hoc checks.

## 5. IndexedDB rejects `boolean` as an index key — store `0 | 1`

A record whose indexed field is `true`/`false` is **never entered into that index**, so
`.where('isRead').equals(...)` returns nothing regardless of the queried type. This silently broke
the unread badge and the bookmark stat (both permanently 0).

- Persist `isRead` / `isBookmarked` as `0 | 1`.
- Query with `0` / `1`. If you need `as any` to make a Dexie query compile, the schema is wrong —
  stop and fix the stored type.
- All read sites use truthiness (`Boolean(p.isBookmarked)`, `if (!p.isRead)`), so `0|1` is
  read-compatible — but keep it that way; never compare `=== true`.

## 6. The service worker cannot `sendMessage` to itself

`chrome.runtime.sendMessage` is never delivered to a listener in the **sending** context. Code
reachable from both the SW (alarms, auto-sync) and the UI must branch:

```ts
import { IS_SERVICE_WORKER } from '@/utils/runtime';
// in the SW: call performBgFetch(...) directly; from a page: send BG_FETCH
```

This is why `performBgFetch` is exported from `bgFetch.ts`. Background auto-sync failed for every
platform because adapters messaged `BG_FETCH` from inside the SW and got `lastError`.

## 7. MV3 lifecycle invariants (already correct — keep them)

- Register all `chrome.*` listeners synchronously at top level in `defineBackground`.
- Never hold mutable state in SW module scope; it dies with the worker.
- Async message handlers: wrap in an IIFE, call `sendResponse` exactly once on every path,
  `return true`. A wrong return value silently drops the reply.
- `chrome.alarms.create` with an existing name **replaces** the alarm and restarts its countdown.
  Check `alarms.get` first; only `onInstalled` and settings changes may (re)create.
- Use `chrome.alarms`, never `setInterval`, for periodic work.
- DNR dynamic rules persist across restarts; `removeRuleIds` before `addRules`.

## 8. Layering

`types → adapters/platform → infrastructure/db + sync → application → entrypoints (UI)`

- Adapters MUST NOT import the db. Repositories MUST NOT import `chrome.*`.
- The `application/` facade layer is currently **half-adopted** (#10). Until that is resolved, do
  not add new direct `infrastructure/db` imports from UI code.
- New platform = new file in `src/adapters/` implementing `PlatformAdapter`; register in
  `src/platform/registry.ts`. See `docs/REVIEW_2026-09.md` for the full 6-8 touch-point list.

---

## Fix queue

Ordered. Items 1-4 are in flight this session; 5-12 are queued.

### In flight

1. **`bgFetch` credential host matching** — done: `hosts.ts` + `senderGuard.ts` added; `bgFetch.ts`
   rewritten (hostname-exact token injection, GET-only, credentials by allowlist,
   `performBgFetch` exported for SW use).
2. **Sender validation + router policy table** — in progress: `senderGuard.ts` written,
   `background.ts` router not yet wired.
3. **`isRead`/`isBookmarked` → `0|1`** — not started. Needs Dexie `version(4)` upgrade migrating
   existing rows, 10 adapter write sites, `setPostRead`/`setPostBookmarked`, `autoSync.ts:45`,
   `statsService.ts:10` (drop the `as any`).
4. **Auto-sync alarm** — not started. `alarms.get` guard **and** the SW-messaging fix from rule 6,
   otherwise the alarm fires into a dead fetch path.

Known broken state at time of writing: `src/utils/runtime.ts` fails to compile —
`ServiceWorkerGlobalScope` is not in `tsconfig.json`'s `lib` (needs `WebWorker`).

### Queued

5. DNR rules: add `initiatorDomains`, drop `sub_frame` (`declarativeNetRequest.ts:11-131`).
6. Data integrity in adapters: stable post IDs (no `Math.random()` fallback), `btoa` → `TextEncoder`
   for non-ASCII guids, `Number.isFinite` guard on parsed timestamps.
7. `parseBackup`: check `version`, validate per-record required fields.
8. `FetchResult.error` → `{ code: 'auth'|'rate_limit'|'network'|'parse'|'timeout', message, retryable }`;
   remove the silent RSS fallback in `getAdapter`.
9. Use the existing indexes: `[channelId+publishedAt]` for the watermark, `channelId` for tombstones.
10. Resolve the `application/` layer; merge the two cookie-auth tables; extract a `buildPost` factory.
11. Split `CreatorsView.vue` (1420 lines); extract `BaseModal` with `role="dialog"`, focus trap, Escape.
12. Add lint + typecheck CI; regression tests for items 1, 3, 4, 6.
