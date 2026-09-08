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

All 12 items are DONE (queues 1-4 in commit 25b8217, queues 5-12 in the
follow-up series). Kept as a record of what was fixed and where the rule came
from.

1. `bgFetch` credential host matching — `hosts.ts` + `senderGuard.ts`; hostname-exact token injection, GET-only, credentials by allowlist.
2. Sender validation — router policy table in `background.ts`.
3. `isRead`/`isBookmarked` → `0|1` with Dexie v4 migration (posts + tombstone snapshots).
4. Auto-sync alarm guard + SW-direct `performBgFetch` (`IS_SERVICE_WORKER`).
5. DNR rules scoped with `initiatorDomains: [chrome.runtime.id]`, `sub_frame` dropped, applied on install only.
6. Adapter data integrity: no `Math.random()` post IDs (skip or content-hash), `btoa` → TextEncoder hash (rss `stableHash`), `Number.isFinite` guards on all parsed timestamps.
7. `parseBackup`: version gate + per-record required-field validation, fail-fast.
8. `FetchResult.error` → structured `FetchError { code, message, retryable }`; adapters classify; `channelSync` switches on codes; silent RSS fallback removed from `getAdapter`.
9. Index-backed queries: watermark via `[channelId+publishedAt].last()`, tombstones via `channelId` index, bilibili dedup streams instead of materializing.
10. `application/` layer resolved (popup writes via services, dead `platformAuthService` deleted); cookie-auth table single-sourced in `platformAuth.ts`; `buildPost` factory for the 13 adapter literals.
11. `CreatorsView` 1420 → ~1100 lines via `PlatformBadge` / `ChannelRow` / `CreatorCardHeader`; `BaseModal` (dialog semantics, focus trap, scroll lock) adopted by all 6 modals.
12. CI (`.github/workflows/ci.yml`: typecheck + vitest + build), 37 regression tests (hosts/senderGuard/FetchError/buildPost/backup validation/component SSR), `typescript` pinned to 7.0.2.
