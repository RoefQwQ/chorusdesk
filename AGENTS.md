# AGENTS.md — Chorus / chorusdesk

Binding constraints for anyone (human or agent) editing this repo. Reusable rules only.
One-off review output lives in `docs/REVIEW_2026-09.md` — do not copy it here.
**Current work queue lives in `docs/PROJECT_PROGRESS_2026-09.md` §四.P8 (交接队列)** — read that
before planning anything. Batch history is `docs/archive/2026-09-batches.md` (frozen, never a
to-do list).
Rule numbers are stable. Several rules cite **`docs/AGENTS_CASES.md`**, which holds the pre-split
incident narrative, measurements and logs behind them — evidence, not the binding text.

Stack: WXT 0.21 + Vue 3 + Dexie 4 + Tailwind 4, TypeScript strict, Chrome MV3.
Commands: `npm run dev` / `build` / `zip` / `test` / `typecheck` / `lint`. CI runs typecheck + lint + vitest + build on every push/PR (fix queue #12); tagging `vX.Y.Z` runs `release.yml` (same gates + tag/version check + release asset).

`typecheck` runs **twice on purpose**: `tsc` (native TS7, `.ts` only) then `vue-tsc` (`.vue` + `.ts`). A plain `tsc` pass parses **zero** `.vue` files, so before vue-tsc was added the gate silently could not see any component: a deleted `ref` still referenced by a template, a prop that did not exist on the type it was read from, and an undeclared `emit` all shipped green. Do not "simplify" this back to one command.

---

## Non-goals (settled — do not re-open, do not propose)

Decisions the user has already made. Re-raising one as a "found issue" or a "small
follow-up" wastes their time; if new evidence genuinely contradicts a decision, say so
once, with the evidence, and wait.

- **A video post needs no badge on its thumbnail.** The footer link already reads
  「视频动态」 for exactly those posts, so it is the at-rest identifier; an extra icon over
  the media would repeat it a third time (the hover prompt being the second). Asked and
  declined 2026-09-11: 「现在右下角本来就有文字标识，为啥还要额外加一个」. Do not propose a
  play icon, a corner badge, or a duration pill for video thumbnails.
- **RSS cards do not need images.** Card rendering for RSS is text-first by decision
  (2026-09-11: 「rss不需要这个」). The article *reader* view still renders the article's
  images — that part is in scope and works. Do not add a thumbnail, a count hint, or an
  option for card images, and do not report their absence as a defect.

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
Adding a platform means editing **that list alone**:

1. `PLATFORM_HOSTS` — the allowlist.
2. Nothing else. The manifest's `host_permissions` is *derived* (`wxt.config.ts` calls
   `platformHostMatchPatterns()`), and the image proxy's allowlist, credential policy and
   Referer choice all read the same list.

Never inline a second host list in a handler, adapter, or composable. This is not
hypothetical: `proxyImage` kept its own alternation regex while the docs and the P0
verification checklist claimed Douyin covers load through it — the handler answered
`Image host is not allowed` and the only fallback for those covers never ran.
`tests/hosts.singleSource.test.ts` asserts the derivation, that the proxy has no private
list, and that every Referer key is a declared platform host.

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
  `FETCH_TWITTER_TIMELINE`, `FETCH_DOUYIN_SNAPSHOT`).
- `isContentScriptSenderOn(sender, host)` — parameterized pattern for page-driven credential
  relays (hostname-exact). Kept as a utility with tests; no live content scripts exist today
  (the rplay.live relay was removed with the platform, 2026-09).

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
- **A message that tells the worker to reconcile state MUST be sent after that state is stored.**
  The worker reads it back, so notifying first makes it act on the previous value — the
  auto-sync switch did exactly that and *cleared* the alarm the user had just enabled, because
  `setupAutoSync` read `enableAutoSync: false` before the settings write committed. The symptom
  was invisible: the next worker start reads the stored setting and repairs it, so the switch
  only looked "slow". `await` the write, then notify.
- Use `chrome.alarms`, never `setInterval`, for periodic work.
- DNR dynamic rules persist across restarts; `removeRuleIds` before `addRules`.
- **There is no `tabs` permission, by design** (removed 2026-09). `tabs.query` still works and
  still hands back `url`/`title` — but only for tabs whose page we hold host permissions for
  (`PLATFORM_HOSTS`), plus the active tab inside the popup via `activeTab`. Everything else
  (including this extension's own pages) comes back with `url: undefined`, so never branch on
  a tab URL without a platform-host fallback. Verified live in Chrome, 2026-09-11; see
  `PROJECT_PROGRESS_2026-09.md` §四.P7.

## 8. Layering

`types → adapters/platform → infrastructure/db + sync → application → entrypoints (UI)`

- Adapters MUST NOT import the db. Repositories MUST NOT import `chrome.*`.
- **Adapters reach the network through `src/infrastructure/chrome/http.ts` (`bgFetch`).** That port
  lives in the chrome layer, not in `utils`, because its service-worker mode calls
  `performBgFetch`, which reads `chrome.cookies`. So `adapters → infrastructure/chrome` is a real,
  sanctioned edge — it is how every adapter fetches. (It used to be laundered through a mislocated
  `utils/http.ts`, which also made a leaf layer depend on the chrome layer. Moved 2026-09-11; see
  `docs/REVIEW_2026-09.md`.)
- **The `application/` facade covers the writes, not everything.** Creator / channel / post /
  backup go through `src/application` (`creatorService`, `channelService`, `postService`,
  `backupService`) — including the whole recycle-bin lifecycle, which used to import seven
  repository functions directly from the UI. What still imports `src/infrastructure/db/*` directly
  from UI is the bare `db` handle, `settingsRepository`, `statsService` and media maintenance
  (`healBrokenPostMedia`, `cleanupOldPosts`) — 8 call sites as of 2026-09-11, down from 9. Fix
  queue #10 resolved the *facade*, so do not restate it as unfinished; equally, do not treat the
  remaining direct imports as sanctioned. Prefer adding a service method over a new direct
  repository import.
- New platform = new file in `src/adapters/` implementing `PlatformAdapter`; register in
  `src/platform/registry.ts`. See `docs/REVIEW_2026-09.md` for the full 6-8 touch-point list.

## 9. Page-driven platforms keep their scraping in an isolated layer

Douyin cannot be fetched from the service worker at all: a `bgFetch` of a creator page returns HTTP
200 with an anti-bot JS challenge shell and zero post data. Its acquisition therefore runs in the
page (`chrome.scripting.executeScript` into an open douyin.com tab, the `twitterTimeline.ts` pattern).

For any platform in that shape, keep the boundary:

- `src/adapters/<p>/collector.ts` — runs in the page. Self-contained (it is stringified for
  injection): no imports, no closure over module scope, no `chrome.*`. Reads rendered DOM only —
  never `document.cookie`, `localStorage`, request headers, or device/signature state.
- `src/adapters/<p>/contract.ts` — validates the snapshot. Everything from the page is UNTRUSTED:
  bound array counts and text/URL lengths, reject non-http(s) and off-allowlist media hosts, and
  drop any item lacking a stable id or a finite plausible timestamp.
- `src/adapters/<p>.ts` — maps the validated DTO onto `Post` via `buildPost`.

**"Self-contained" is not advice, and `chrome.scripting` is not only Douyin's.** The injected
function is serialized with `Function.prototype.toString()`, so it carries **no closure**: every
identifier must be a parameter, a local, or a page global. Twitter's injected function read
`Bearer ${TWITTER_BEARER_TOKEN}` — a module constant — for as long as that path existed. In the page
that is a `ReferenceError`, caught by the function's own `try/catch`, returned as a plain failure, and
the sync fell through to the direct fetch. **The page path never ran once, in production, and nothing
could tell**: the failure looked like a platform problem, and `PLATFORMS.md`'s advice to open the
creator's profile and retry was inert.

Two things made it invisible, and both are the general lesson:

- An injected function that catches its own errors converts a programming mistake into a plausible
  platform message. Assert on the *result*, never on "it did not throw".
- Calling the function **object** in a test keeps the closure and passes; only evaluating its
  **source** with no closure reproduces what Chrome does. `tests/twitterTimeline.injected.test.ts`
  does that, and it is the template for any new injected path.

Constants for an injected function travel through `executeScript`'s `args` (Twitter: the bearer plus
the four GraphQL sets — one definition, shared with the direct fetch, which is also why the two can no
longer drift).

Nothing else may learn the page's shape. When the markup changes, only the collector, the contract,
and the fixtures should need edits — never the db, `channelSync`, `buildPost`, or another platform.

Two further invariants this exposed, both easy to miss:

- **Do not persist a signed CDN URL as identity or as a click target.** Douyin covers carry
  `x-expires`/`x-signature`; a Post's `originalUrl` must be the canonical work page. Conversely, do
  not "clean" query strings off media URLs — stripping the signature 403s every image.
- **A new platform must add its generated placeholder-name prefixes to BOTH prefix lists in
  `channelSync.ts`** (channel `displayName` and creator `name`). A platform missing from those lists
  keeps its `平台用户_xxxx` placeholder forever, because the real nickname is only allowed to
  overwrite a name the sync layer recognizes as a placeholder.

## 10. Probe the page's real scroll container before declaring "no pagination"

Douyin's creator page does not scroll the window: the work grid lives inside
`.route-scroll-container`, and only that element's `scrollTop` drives its lazy loader. The V1 spike
drove `window.scrollTo`, watched the item count never move, and recorded "no reliable pagination" —
a wrong conclusion baked into the adapter and the docs, because the window never scrolls at all
there (document height stays under the viewport), so that probe could only ever fail.

Before concluding a feed cannot page: enumerate elements whose `scrollHeight > clientHeight` and
check which one contains the feed. Walk the feed's scrollable ancestors and drive those.

Equally important — **a grid that stops growing is not proof it is finished.** The two cases must
be told apart from evidence, never guessed:

- **Do not treat "shorter than the stated total" as evidence of truncation.** The profile's work
  count **includes works the author has hidden** (confirmed against a real creator, 2026-09-11),
  so a profile with hidden works permanently loads fewer than it states. That makes the count a
  one-way signal only: loading *at least* as many as stated proves the grid is complete; loading
  fewer proves nothing.
  - Corollary: the "18 of a stated 29" measurement this rule was originally based on **is not
    established evidence of an anonymous login wall** — 18 visible with 29 stated may equally have
    been 11 hidden works and a complete grid. Do not cite it as proof.
- Short of the total ⇒ do NOT return `hasMore: false`. That is the end-of-history signal, and
  `channelSync` writes `__END__`, permanently blocking the dig from ever resuming. The asymmetry
  is deliberate: wrongly claiming complete is unrecoverable, wrongly staying resumable costs one
  re-scroll.
- **Report the shortfall without blaming the user.** A message that reads as "you should be seeing
  all N" sends them to log in for a shortfall logging in cannot fix. Name the count as a total that
  includes hidden works, and say a shortfall is expected.
- Report the shortfall as a real error naming it, never as a successful sync with 0 new posts.

See `docs/DOUYIN_RESEARCH_2026-09.md` for the surrounding survey (official API limits, the signing
schemes, and why the extension must not take the API route).

## 11. The developer log is user-visible: redact at the call site

`src/utils/devLog.ts` writes a 150-entry ring into `chrome.storage.session` and the dashboard's
Developer Log panel renders it — the panel exists so a packaged extension can be diagnosed
without devtools, which means **its contents get screenshotted into bug reports**.

- Log hostnames, HTTP status codes, counts, and error messages. NEVER log cookies, tokens,
  request headers, response bodies, or full URLs (query strings carry signatures).
- Never let logging affect behavior: `record()` is synchronous and fire-and-forget, failures
  are swallowed, and `flush()` exists only for tests and pre-shutdown durability.
- Levels: `debug` for high-volume success paths (kept only while the panel's verbose switch is
  on), `warn`/`error` for anything a user would need to see.
- Storage is `session`, never `local`: logs must not reach a backup export or survive a restart.

## 12. A user gesture is consumed by `permissions.request`

`chrome.permissions.request` only works while the click's gesture token is live, and it consumes
it. Any handler that may need a runtime grant MUST call it as the **first** `chrome.*` call —
before `permissions.contains`, before status flags, before any unrelated `await`.

RSS is the only platform needing this (`optional_host_permissions`, AGENTS.md rule 3): its hosts
are user-supplied and cannot be allowlisted. Already-granted origins resolve `true` without a
prompt, so the call is safe to make unconditionally.

## 13. An empty platform result is an error, not a successful zero-post sync

A sync that returns zero posts is only credible when the adapter can name *why* it is zero:

| Situation | Verdict |
|---|---|
| Adapter filtered internally against the watermark (bilibili, douyin) | success — report `totalFetched` so the log distinguishes this |
| Adapter returned a page that `channelSync` then filtered as already-known (weibo, youtube) | success |
| Platform returned no items at all, or none matching the parser's shape | **error** |

The third case was live on three platforms at once: four Twitter channels reported
「同步完成 0 条，hasMore=false」with no error while the GraphQL payload contained no tweet
entries at all (`hasMore=false` is the tell — it means no bottom cursor was found either).
Xiaohongshu had the same shape when its profile state carried no notes.

- `hasMore === false` on a *history dig* parks the cursor at `__END__`, so a fake empty
  success can permanently block a channel from ever resuming.
- Adapters MUST return an error naming the likely cause when the platform yielded nothing
  to parse, and MUST set `totalFetched` (raw count before filtering) on success paths that
  filter internally. `channelSync` logs it as `平台原始 N 条`.

## 14. A UI action that writes the DB MUST reload the rendered snapshot

`useDashboardData`'s `creators` / `channels` / `posts` are a **snapshot**. Every action that
mutates them through the sync or repository layers MUST finish with `deps.reloadData()`,
including on the failure path — an error changes `status` / `errorMessage` too.

`handleRefreshChannel` omitted it while `handleRefreshAll`, `handleRefreshCreator` and the
deep-sync driver all had it. Consequence: syncing one account from its row updated the row in
IndexedDB but left the previous render on screen, so a **successful** sync kept showing the old
「同步失败」badge and its error text until the user reloaded the page by hand — and a freshly
introduced failure was equally invisible. Put the reload in `finally`, not after the success
branch.

## 15. `asRecord()` is never falsy — `asRecord(a) || asRecord(b)` is dead code

`asRecord()` returns `{}` for a miss, and **`{}` is truthy**. So the natural "try one path,
then another" idiom silently evaluates only the left side:

```ts
// BOTH fallbacks below never run. This is how the Twitter adapter shipped
// reading `tweet_results.tweet_results.result` (one level too deep) while every
// channel reported a successful sync with zero posts.
const tweetResult = asRecord(a.tweet_results.result) || asRecord(b.tweet_results.result);
const card = asRecord(item.noteCard) || item;
```

Use `firstFilled(...candidates)` (`src/utils/json.ts`) when "first non-empty wins" is meant.
Sweep for this shape whenever touching an adapter — it has appeared three times.

Related and worse in combination: **a test fixture must come from a real payload.** A fixture
written to match what the parser currently reads only proves the parser agrees with itself; the
doubled-nesting fixture above locked this bug in as expected behaviour, and it survived typecheck,
lint and the whole suite. When a parser reads a third-party response, keep at least one fixture
captured verbatim from the platform.

## 16. Fixing an adapter does NOT fix the rows already stored

A normal sync is incremental: `channelSync` filters against the newest stored `publishedAt` and
writes only what is newer, so **existing rows are never rewritten**. A parser fix changes what
future syncs produce and nothing else — the returned `Post` and the database row are two
different things.

- When a defect produced **stored** bad data, either repair those rows in `channelSync` or give
  the user an explicit path (`Shift + click` forces a rewrite). Say which, and say it in the
  response.
- Repairs MUST be gated by a rule that can only match a shape the bug itself produced
  (`shouldRepairStoredContent` is the worked example), and the predicate MUST be derived from
  observed data — never from an assumption about your own old code. A repair rule that has never
  been observed to fire is not a working rule.
- Keep repairs bounded (the ids the adapter just returned — never a table scan), silent (a
  repaired row is not a new post), and preserve user state (`isRead` / `isBookmarked`).
- The log line is the evidence: `新增 0 条` with a non-zero platform count means nothing was
  written, so a fix that only touched the adapter cannot have taken effect.
- A row outside the adapter's newest-N window can never acquire a fresh counterpart, so no sync
  will repair it — that is the case rule 22's Dexie migration exists for.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-16).

---

## 17. A feed's summary is not its article — read `<content:encoded>` (and never race a client-rendered page)

Two acquisition defects, both from trusting a cheaper signal than the one that answers the
question.

- **RSS: the feed's own truncation is not the article.** `querySelector('content')` does not match
  `<content:encoded>`. Read the full element first, then fall back:
  `getElementsByTagName('content:encoded')` → `content` → `description`/`summary`. The namespaced
  name needs the qualified lookup — a CSS selector would need the colon escaped.
- **Size a body cap from measured articles, not from taste.** The previous 4000-character ceiling
  truncated 9 of 10 real articles.
- **A client-rendered grid: loading is not rendering.** `status === 'complete'` plus a fixed sleep
  is a guess about someone else's renderer. Wait for the *thing you need*, in the page and bounded
  (inject a self-contained probe that polls for the grid to hold a card — see `awaitDouyinGrid`),
  then scrape.
- A readiness timeout MUST NOT abort the scrape: a captcha or an auth wall is diagnosed better by
  the collector than by a timeout. A fixed sleep after `load` is acceptable only as a short settle
  before a real readiness check.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-17).

---

## 18. Third-party HTML is sanitized at the boundary, and structure is rendered, not flattened

An RSS item's `<content:encoded>` is **arbitrary markup authored by whoever controls the
feed**. The reader renders the body, and once it renders markup it does so inside an
extension page — a page that holds the user's cookies. This is therefore a code-execution
boundary, not a formatting concern.

- Sanitize **at parse time** in the adapter (`src/utils/sanitizeHtml.ts`), so stored data is
  already safe and no renderer has to remember that a feed is untrusted.
- The policy is an allowlist, and unknown elements are **unwrapped** (children kept) while
  `script`/`style`/`iframe`/`form`/`svg` are **dropped with their subtree** — unwrapping
  `<style>` would print its CSS into the article as text, and `svg`/`math` are a different
  namespace where `tagName` cannot distinguish an `xlink:href` carrier from a plain `<a>`.
- URLs are validated by **parsing and testing the protocol**, never by prefix-matching the
  raw string: `java\nscript:` and a leading control character are the standard bypasses.
  Relative URLs resolve against the article's link (a bare `/img.png` on a
  `chrome-extension://` page resolves against the extension and 404s). `href`/`src` are set
  explicitly and are never copied by the generic attribute loop.
- Serialize nodes **this code created**; never rewrite the input's markup with patterns.

The other half of the lesson: **a feed's structure is its content.** Flattening an article to
text is what pushed every image into a gallery under the body (measured: 23 images in one
article, rendered as a "+17" placeholder grid) and left headings indistinguishable from
paragraphs. Store the structure (`Post.contentHtml`), render it with tag-level typography
(`.article-body` in `assets/main.css`), and **do not render the same media twice** —
`standaloneMedia()` is the single rule both the card and the reader use.

### The image proxy: reachability is not credentials

`proxyImage` used to refuse any host outside `PLATFORM_HOSTS`. A feed may host its images
anywhere, and the proxy is the only path that can load a CDN which blocks hotlinking or sends
no CORS header — so every RSS article image was unreadable. The check was the same category
error as rule 3, one layer down: **any http(s) host may be fetched; only a platform host
gets the user's session** (`credentials: 'include'`, platform `Referer`). Reachability was
never what the allowlist was for.

Any change here MUST keep those two properties pinned together: `tests/proxyImage.test.ts`
asserts both that an unknown host is fetched *and* that it receives no cookies.

---

## 19. Pacing is measured from the end of a request, and a rate limit is remembered

- **Measure from the end of the previous request**, and record the timestamp on every path
  including failure — a failed request still hit the platform.
- **A platform's spacing floor is platform knowledge, not a setting.** It lives on
  `PlatformAdapter.minRequestIntervalMs`; callers pass the user's configured delay as an override
  and the loop combines them with `Math.max`, so an override may *raise* the floor but never lower
  it.
- **A cool-down must outlive the process that detected it.** Strike count and expiry are persisted
  (`sync.platformCooldown`, read/validated by `src/sync/rateLimit.ts`) because the MV3 service
  worker dies between syncs. The back-off doubles per consecutive signal and is capped, so a
  hostile platform cannot lock itself out indefinitely; **a clean request clears it**.
- **Detecting the limit and then continuing to hammer the platform is worse than not detecting
  it.** A `rate_limit` result starts a cool-down and the rest of that platform is skipped for the
  remainder of the run and subsequent runs.
- **Every sync entry point needs this** — the batch loop and `updateCreator` alike.
- Non-retryable errors in one platform MUST NOT stop the others: a cooling platform is skipped,
  not fatal.
- **Classify a verification redirect as a rate limit, not as `network`.** The observable fact is
  that the tab is no longer on the creator's profile, whatever it was moved to.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-19).

---

## 20. The developer log is a product surface — per-card telemetry is noise

The log panel exists so the user can read it, and (in practice) paste it back when reporting a
problem. Its signal-to-noise ratio is therefore a feature, and a per-item debug line inside a
list is a defect in it.

Measured on a real session: **102 of 150 lines (68%) were the per-card `磁盘探测` line**, in
bursts of 72 and 26 as the feed was scrolled, around 11 lines that actually said what happened.
Both of that user's last two log pastes had to be trimmed by hand to find the useful window.

- Anything that fires **once per rendered item** must be **summed over a quiet period**, not
  emitted per item. Cards probe in bursts (a render or scroll brings many into the observer's
  margin at once), so one line per burst keeps every fact: how many cards, how many of their
  images were cached, the worst case, and which platform it was.
- **Sum, never sample or rate-limit.** Dropping lines would hide the one slow card that matters.
  Nothing is lost in an aggregate; that is the whole point.
- Let **severity carry the alarm**: a burst containing a slow card is emitted once at `warn`,
  with the worst platform named for triage. Reporting a slow cache once per affected card is how
  the original warning became part of the noise it was meant to cut through.

---

## 21. A comment that asserts upstream behaviour is a guess — and a fixture built on it ships the bug green

- **Never rely on an upstream field for a behaviour you have not measured.** If a comment says
  what an API does, it needs a fixture taken from a real payload behind it, or it is a guess
  wearing a citation. (`display_text_range` exists to exclude *leading @mentions*; it does **not**
  exclude the media link X appends.)
- **Remove only what the payload says it appended**: take each media entity's `url` and remove
  that exact substring. Do not use the range for it, and never strip `entities.urls` —
  author-typed links, including mid-caption ones, are content.
- **A fixture must contain the fields the fix depends on**, and every third-party parser keeps at
  least one fixture captured verbatim from the platform.
- **A payload's data is spread across levels, so a fix must survive being asked the wrong level.**
  Collect **every** media array in the payload and let each consumer pick (display wants the first
  non-empty; link stripping wants the union, because text and entities can come from different
  levels), plus the narrower pass for payloads that name nothing — gated on the tweet having media
  while `entities.urls` is empty.
- **A repair rule must be as narrow as the removal rule**: stored text must *begin with* the fresh
  text and end in nothing but t.co links, because "starts with" alone also matches a row the
  author simply kept writing.
- **"It works sometimes" is a description of a condition to find**, not a reason to test harder.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-21).

---

## 22. A migration test that re-implements the migration tests nothing

`channelSync` repairs stored rows the adapter returns, but a normal sync only returns a channel's
newest ~10 posts. A row older than that window **can never acquire a fresh counterpart**, and no
UI action rewrites it either — force refresh replaces what the adapter returns, which is the same
newest-N. So a parser fix plus a repair rule is still not enough for old rows; the last resort is
a Dexie migration (here v5, cleaning stored tweets and tombstone snapshots).

Two things this cost:

- **Export the migration rule and have the test use it.** The first version of the migration test
  declared its own copy of the upgrade callback — which is how the existing v4 test is written,
  to pin the schema independently. The result was a test asserting a *copy* of the behaviour: a
  mutation removing the media gate from the shipped rule left it green. Declare the version
  chain inline (that is what pins the shape), but call the production callback.
- On a media post, a **trailing** t.co link is removable; a mid-caption one is not. The database
  keeps no entity list, so the text-only rule must be narrower than the adapter's — which is why
  the two live in `src/utils/tco.ts` as separate functions with separate justifications.

---

## 23. An injection has run only if it returned a value — "resolved" is not "ran"

`chrome.scripting.executeScript` into a tab that navigates does **not** reliably reject: it can
resolve with **no result**, because the frame it was running in is gone. A resolution is therefore
not evidence that anything ran.

- The injected functions here return a boolean or an object by construction, so "produced a
  value" is a sound test of "ran to completion". Classify rejected / valueless / successful
  separately (`InjectionOutcome`) and retry the valueless case — it is transient.
- **Retry the collector too, not just the readiness probe.** A collector always returns an object
  (an empty one for an empty grid), so no result is never data. Two very different conditions
  must not share a message.
- **A timing contradiction in a log is a bug report about the code, not the network.** "It gave up
  before its own deadline" is arithmetic, and it localizes the fault immediately.
- Retries are bounded (`INJECT_ATTEMPTS`) and the failure is still surfaced, so a page that keeps
  dying reports a real error instead of spinning.
- **Once a diagnostic has answered its question, stop shipping it as an alarm** — a warning that
  fires on the ordinary case reads as a problem when nothing is wrong.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-23).

---

## 24. Removing a guard needs a test on the guard, not on what it produced

When a guard's purpose is a magnitude (a timeout, a budget, a retry window), **assert the
magnitude**. Presence and ordering are not the property; the quantity is. A test that only pins
the guard's effect does not pin the guard.

- A theory that predicts a function's failure MUST be tested against that function's successes.
- When the evidence for removing a guard is "it logged failures but the thing worked anyway", the
  guard is doing its job loudly — check what it is *buying* before deleting it.
- **A DEBUG line about a recoverable condition is not a bug report.** Retrying and then succeeding
  is the system working; treating that as a defect is how the guard itself gets deleted.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-24).

---

## 25. Visual verification opens its OWN browser — never the user's

Checking a rendered page is worth doing, and the browser tooling makes it easy to do
destructively. `browser.open` **without an `app`** drives the user's real Chrome through the
relay; relay mode with no `tab`/`target` **adopts the visible tab**, so passing a `url`
navigates away from whatever they were reading. Doing this at all during a debugging session
is a violation of the standing rule that only pages this work created may be touched.

Always isolate:

```js
// Spawn a throwaway Chrome, then attach to it by CDP.
hub({ op: 'start', name: '<name>', application: '<chrome>',
      args: ['--user-data-dir=<temp profile>', '--remote-debugging-port=<port>', ...],
      ready: { port } });
browser.open({ app: { cdp_url: 'http://127.0.0.1:<port>' }, url, viewport });
```

- Never `browser.open` without `app` for a debug render. `/json/list` on the relay is
  read-only and fine when something needs checking, but nothing should be *driven* there.
- Use a dedicated `--user-data-dir` so the instance starts clean and never inherits the real
  profile's session, and stop the process (`hub stop`) plus delete the profile when done.
- This is also the honest framing: an isolated instance cannot be the user's session, so a
  bug cannot be mis-attributed to it and a fix cannot be "verified" against their state.

The user's browser is the one place in this project where a mistake is not recoverable by
`git revert` — they lose whatever they were reading. Treat it as read-only, always.

---

## 26. A mutation/edit script that matches nothing produces a green suite, and the green suite is a lie

`str.replace` has no "found nothing" signal, so an edit that matched nothing looks exactly like an
edit that worked:

```python
s = open(p).read()
s = s.replace(old, new)          # 0 replacements: no error, no output
open(p, 'w').write(s)            # writes the file back, unchanged
```

- Every scripted edit MUST assert its own application before its result means anything:
  `assert s.count(old) == 1, s.count(old)` — or the expected count, or the printed delta.
- **Mutations**: after editing, re-read the file and confirm the mutated string is present (or the
  original gone) *before* running the suite. A mutation run reporting `no tests` means the file
  failed to parse — a broken mutation, not a passing test.
- **Line endings**: these files have been both CRLF and LF, and a multi-line anchor written with
  `\n` matches nothing in a CRLF file. Prefer single-line anchors, or read/write with
  `newline=''`. `git config core.autocrlf` is `true` here, so the checked-in form is LF and the
  working tree may be either — never assume.
- **An edit that reports no failure is not an edit that succeeded.** Confirm the tree changed, then
  judge the result — one `assert` or one re-read is cheap.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-26).

---

## 27. A component used in a template but never imported renders as NOTHING, silently

A component used in a template but never imported compiles to an empty placeholder **without a
warning** — the column renders blank, the icon button renders bare.

- `vueCompilerOptions.strictTemplates` is **on** (2026-09-11) and is what makes the gate able to
  see component-level mistakes at all: the missing import becomes
  `error TS2339: Property 'PlatformBadge' does not exist on type '{}'`. Do not turn it off.
- **`aria-*` is an attribute namespace, not a prop.** `strictTemplates` rejects
  `aria-label="…"` on a component as an unknown prop. The fix is the `ComponentCustomProps`
  augmentation in `types/vue-augment.d.ts` — not reverting the setting, not renaming the
  attribute, and not declaring an `ariaLabel` prop (the tooling would then dictate the API, and
  camelCase props render as lowercase garbage: `ariaLabel` → `arialabel`, a real bug the SSR test
  caught). `inheritAttrs: false` + `v-bind="$attrs"` on the real interactive element is the
  working shape.
- **A generic component's `v-model` cannot be secretly narrow.** `AppSelect` declared
  `modelValue: string | number` while call sites bound it to `CreatorSortKey`, `number` and
  `DevLogLevel | 'all'`. `<script setup generic="T extends string | number">` is what makes the
  compiler check the pair.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-27).

---

## 28. A full extension E2E IS available — but only via CDP, and only within one browser session

A full extension E2E **is** available here, via CDP — but `--load-extension` is ignored by regular
Chrome (since 137), and the flag that decides whether CDP can load the build is
`--enable-unsafe-extension-debugging`: without it `Extensions.loadUnpacked` fails with
`Method not available`.

```js
hub({ op: 'start', name: '<name>', application: '<chrome>', args: [
  '--user-data-dir=<temp>', '--remote-debugging-port=<port>', '--remote-allow-origins=*',
  '--enable-unsafe-extension-debugging',   // ← the flag that decides this
  '--window-position=-2400,-2400',         // off-screen: the user is not disturbed
], ready: { port: <port> } });
await cdp('Extensions.loadUnpacked', { path: '<repo>/.output/chrome-mv3' });  // → { id }
```

With it, the extension's **service worker** appears as a target (`background.js`) and can be
evaluated in, so `chrome.alarms`, `chrome.tabs`, message handlers and the router are drivable;
**extension pages render for real**; **downloads** can be captured
(`Browser.setDownloadBehavior`) and **file inputs** fed (`DOM.setFileInputFiles`); and IndexedDB
persists in the profile across a browser restart.

- **A native `alert()` blocks the whole renderer, and CDP with it.** Enable the Page domain
  *before* the action and answer `Page.javascriptDialogOpening` (or close the target and reopen —
  the state is already committed). A hang here is the dialog, not a hang in the product.
- **The unpacked extension does not survive a browser restart.** `loadUnpacked` after a restart is
  a fresh install, so anything the profile would have carried (alarm existence, `onInstalled`
  timing) is recreated rather than restored. Cross-restart behaviour therefore stays unverifiable
  here — say that plainly instead of inferring it from a single reading.
- Use the cheap tool when the extension host is not the subject: a component-level render with the
  **production** stylesheet (rule 30) for geometry, jsdom for behaviour. Reach for CDP when the
  host itself is the subject — storage, alarms, messaging, permission gates — not for layout.
- **Before declaring a capability absent, check the flag that governs it**, and treat two launches
  without the intended result as evidence the approach is wrong, not the parameters.
- `--load-extension` remains fine for spawning a *plain* Chrome to view non-extension URLs (rule
  25's recipe) — with a CDP-loaded extension available, that is now mostly a fallback.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-28).

---

## 29. Whitespace in a table is conserved — decide where it goes, and measure

Slack in a wide table is conserved. Measure, decide where it goes, and say which option you
chose — the constraints below are what that measurement produced.

- **The slack is conserved.** ~470px has to live somewhere. There is no allocation that
  removes it; a fix that only moves it produces a new complaint one round later. Say that
  out loud rather than implying the gap can be designed away.
- **Under the default `table-layout: auto`, `w-full` gives the whole remainder to whichever
  column declares no width** — here 已绑平台账号 — and its content is left-aligned, so the
  slack reads as a hole mid-row. Sizing that one column does not help: auto layout re-derives
  the split from content. `table-fixed` plus a width on every column makes the split
  explicit, and then a test can assert it (`tests/creatorsTable.test.ts` asserts the
  percentages sum to 100, because a missing width is what brings the hole back).
- **Adjacent columns' slacks add up visually.** A left-aligned cell sits at its column's
  start and a right-aligned one at its end, so an over-wide 同步状态 next to an over-wide
  操作 produced a single 265px gap — created by the first attempt at this fix. Check
  neighbours, not columns in isolation.
- **Measure the content, not the container.** The first measurement reported "only 12px of
  slack" because it measured the flex wrapper, which fills the cell by definition. Measure
  the rightmost *leaf* element (the badge itself). A measurement that reports the answer you
  expect deserves one more look.
- **Percentages derived from measured content go stale when content changes.** A platform
  with a much longer display name changes the requirement. Re-measure; the numbers carry a
  comment saying so.

Honest framing for the next person: a wide table with narrow content will look airy. The
choice is *where*, and that is the user's call — offer it (table not filling the card is the
other option) rather than silently picking.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-29).

---

## 30. To verify a real component in a real browser, bundle it into one inlined HTML file

Rule 28 covers what cannot be done here (loading the extension). This is the technique that
covers what remains: real layout, real CSS, real component, no extension host.

```bash
# tiny harness: index.html + main.ts mounting the component, plus a vite config with
npx vite build --config .tmp-harness/vite.config.ts
# then inline the emitted JS and CSS into one file
```

Reasons each part is needed, all learned by it failing first:

- **Vite, because Tailwind's content scan is rooted at the harness directory.** The first
  attempt imported `assets/main.css` and produced a page with *no spacing at all*: every
  utility class was absent, so `p-2.5` and `space-y-2` did nothing and rows came out 24px with
  a 0px gap. Inline the **production** stylesheet (`.output/chrome-mv3/assets/main-*.css`)
  instead — then the geometry is the extension's geometry.
- **Inlined, because an ES module cannot be loaded from `file://`.** `<script type="module"
  src="...">` fails with a CORS error ("Cross origin requests are only supported for protocol
  schemes: chrome, chrome-extension, …"), and the page renders empty with no clue why. Putting
  the JS and CSS text directly in the HTML removes the fetch. Use a lambda for the
  replacement — the bundle contains backslashes that `re.sub` reads as group references.
- **Real geometry, not assertions about geometry.** This is what jsdom cannot do, and the
  numbers are worth reading: a scroll viewport's height, whether one copy of a list overflows
  it, where a row boundary actually falls.

### Pitfalls of driving an occluded browser

Three failures that all trace to the same cause — **a window that is not composited produces no
frames**, and a lot of the platform quietly depends on frames:

- **No `rAF`.** `await new Promise(r => requestAnimationFrame(r))` never settles, so a cell
  using it as a step barrier hangs and is killed at the timeout. Use `setTimeout`.
- **No `scroll` event.** `window.scrollTo(...)` moves `scrollY` but never fires the event, so
  anything gated on scroll (`showBackToTop`, lazy loaders) silently stays in its initial state.
  This looks exactly like a product bug and is not one — dispatch `new Event('scroll')` manually,
  and treat "the control did not appear" as unverified until you have. Do not report it as a
  defect without checking `scrollY` and the listener.
- **No screenshot.** The capture API returns "the tab is not visible". Bringing the tab to the
  front may work; raising the user's window over their other work will not, so after one attempt
  stop and verify numerically instead. Say plainly which parts you could not see.

And one about reading Vue state across the bridge: **every read of the DOM must follow an
`await`.** Vue flushes on a microtask, so dispatching an event and reading the DOM on the same
line observes the *previous* render — a working handler then looks like a dead one.

Corollary worth stating: **when a test cannot distinguish two configurations, find out which
one it is and say so.** Removing a `:loop="false"` from a list left the suite green because
jsdom reports every height as 0, so the copy count is always 1 there. The fix was not a
cleverer assertion — it was moving that check to the browser, where the copy count differs
(1 vs 2) and the difference is directly observable.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-30).

---

## 31. A read-only audit must run against a frozen tree, with a bounded scope

- **A read-only audit and an edit of the same files MUST NOT run concurrently.** Every edit
  invalidates a premise and forces a re-verification pass. Point the audit at an immutable
  revision (`git show <sha>:path`), or hold the edits until it delivers.
- **Bound the scope.** "Check EVERY factual claim", with an acceptance criterion demanding
  exhaustive findings and no budget, is a task with no end: name the specific items, ask for "the
  top N by severity", or set a call budget.
- **Match the agent type to the size.** `scout` is fast reconnaissance returning compressed
  context; a 140-claim fact-check is not that.
- Ask for an **interim report every N calls**: delivery only at the end means a stall produces
  nothing at all.
- **Audit then edit, never audit while editing.** If both are wanted in one pass, the audit waits.
- A cancelled audit is not evidence of a stuck agent: look for repeated identical calls (a loop)
  and for compaction having already discarded the earlier work, before blaming the model.

> Full case history, measurements and logs: [docs/AGENTS_CASES.md](docs/AGENTS_CASES.md#rule-31).

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
12. CI (`.github/workflows/ci.yml`: typecheck + lint + vitest + build), 495 regression tests (hosts/senderGuard/FetchError/buildPost/backup validation/component SSR/dexie migration/image-cache probe/manual ordering/dev log), `typescript` pinned to 7.0.2; ESLint flat config added 2026-09 (`eslint.config.js`, TS6-compat alias for typescript-eslint); `vue-tsc` added 2026-09 so typecheck covers `.vue`, and `vueCompilerOptions.strictTemplates` enabled 2026-09-11 (without it an unresolved component tag is invisible to the gate — see rule 27); `release.yml` + tag/version gate added 2026-09; `jsdom` added 2026-09 for the RSS parse/sanitizer tests, which need a real `DOMParser`.
