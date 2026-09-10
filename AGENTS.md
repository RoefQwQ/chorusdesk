# AGENTS.md — Chorus / creator-feed-hub

Binding constraints for anyone (human or agent) editing this repo. Reusable rules only.
One-off review output lives in `docs/REVIEW_2026-09.md` — do not copy it here.

Stack: WXT 0.21 + Vue 3 + Dexie 4 + Tailwind 4, TypeScript strict, Chrome MV3.
Commands: `npm run dev` / `build` / `zip` / `test` / `typecheck` / `lint`. CI runs typecheck + lint + vitest + build on every push/PR (fix queue #12); tagging `vX.Y.Z` runs `release.yml` (same gates + tag/version check + release asset).

`typecheck` runs **twice on purpose**: `tsc` (native TS7, `.ts` only) then `vue-tsc` (`.vue` + `.ts`). A plain `tsc` pass parses **zero** `.vue` files, so before vue-tsc was added the gate silently could not see any component: a deleted `ref` still referenced by a template, a prop that did not exist on the type it was read from, and an undeclared `emit` all shipped green. Do not "simplify" this back to one command.

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
- The `application/` facade layer is currently **half-adopted** (#10). Until that is resolved, do
  not add new direct `infrastructure/db` imports from UI code.
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

Equally important — **a grid that stops growing is not proof it is finished.** Douyin serves
anonymous visitors a truncated grid (measured: 18 of a stated 29 works, then nothing however far it
scrolls). So distinguish the two cases from evidence, don't guess:

- Capture whatever total the page states, and compare it against what loaded.
- Short of the total ⇒ do NOT return `hasMore: false`. That is the end-of-history signal, and
  `channelSync` writes `__END__`, permanently blocking the dig from ever resuming.
- Report the shortfall as a real error naming it, never as a successful sync with 0 new posts.

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

A normal sync is incremental: `channelSync` filters against the newest stored `publishedAt`
and writes only what is newer, so **existing rows are never rewritten**. A parser fix
therefore changes what future syncs produce and nothing else — the user keeps seeing the old
data, and the sync reports「新增 0 条」while doing it.

This was made three times in one session (Twitter body text, then Twitter again, then RSS
truncation) because each round verified the adapter's returned `Post` and stopped there. The
`Post` object and the database row are two different things; a fix is not finished until the
stored rows are handled too.

- When a defect produced **stored** bad data, either repair those rows in `channelSync` or
  give the user an explicit path (`Shift + click` forces a rewrite). Say which, and say it
  in the response.
- Repairs MUST be gated by a rule that can only match a shape the bug itself produced, so
  replacement can never discard correct content. `shouldRepairStoredContent` is the worked
  example: RSS by "the freshly parsed body is strictly longer", Twitter by a body consisting
  solely of a media link.
- **Derive the predicate from observed data, not from an assumption about your own old
  code.** The first RSS rule keyed off "length 353, ends with `...`" — the fingerprint the
  removed 350-character cap would have produced. It never matched a single row, because what
  was actually on disk was the *feed's* summary (measured: 359 characters ending in a single
  `…`). A repair rule that has never been observed to fire is not a working rule; the log
  line「已修正 N 条」absent from a sync that should trigger it is the tell.
- Keep repairs bounded (the ids the adapter just returned — never a table scan), silent
  (a repaired row is not a new post), and preserve user state (`isRead` / `isBookmarked`).
- The log line is the evidence: `新增 0 条` with a non-zero platform count means nothing was
  written, so a fix that only touched the adapter cannot have taken effect.

---

## 17. A feed's summary is not its article — read `<content:encoded>` (and never race a client-rendered page)

Two acquisition defects, both from trusting a cheaper signal than the one that answers the
question.

**RSS: the feed's own truncation.** `rss.ts` read `item.querySelector('description, summary,
content')`. Feeds routinely put a truncated summary in `<description>` and the article in
`<content:encoded>` (RSS) or `<content>` (Atom) — `querySelector('content')` does not match
`<content:encoded>`, so the code got the summary. Measured on a real newsletter feed:
`<description>` 359 characters ending in the feed's own `…`; `<content:encoded>` 31144
characters of markup, 3.7k–14.9k of plain text. The user saw an article stop mid-sentence and
reasonably read it as our bug.

- Read the full element first, then fall back: `getElementsByTagName('content:encoded')`, then
  `content`, then `description`/`summary`. The namespaced name needs the qualified lookup — a
  CSS selector would need the colon escaped.
- Size a body cap from measured articles, not from taste. The previous 4000 ceiling truncated
  9 of 10 real articles.

**Douyin: loading is not rendering.** `waitForTabLoad` resolved on the tab's `status ===
'complete'` plus a fixed 2.5 s sleep. A client-rendered grid is not on screen then; on a cold
background tab the scrape found an empty grid, and the collector could only report "no works"
for a creator that has them. Measured: two of three channels failed while a third, which
happened to load more slowly, succeeded — the fixed sleep raced the page and won only by luck.

- Wait for the *thing you need*, in the page, bounded: inject a self-contained probe that
  polls for the grid to hold a card (see `awaitDouyinGrid`), then scrape.
- A readiness timeout MUST NOT abort the scrape. The page may show a captcha or an auth wall,
  and the collector diagnoses those better than a timeout could.
- A fixed sleep after `load` is a guess about someone else's renderer. It is acceptable only
  as a short settle before a real readiness check.

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

Two independent defects, both surfaced by one user report (*"我刚刚多次抓取触发了验证码风控"*).

**The spacing was measuring the wrong interval.** `batchUpdateChannelsInterleaved` recorded a
platform's timestamp *before* awaiting its request, so the gap between two requests on that
platform was `interval - duration` — **zero for any request slower than the interval**. Douyin's
requests take seconds (a real page load in a tab), so "sync all" fired three page loads back to
back. Measure from when the previous request **finished**, and record it on every path including
failure: a failed request still hit the platform.

**A platform's spacing floor is platform knowledge.** It lives on `PlatformAdapter`
(`minRequestIntervalMs`; Douyin declares 15 s because a request there is a page load, not an API
call). Callers pass the user's configured delay as an override, and the loop combines them with
`Math.max` — an override may *raise* the floor but never lower it. Using `??` here let a default
setting of 800 ms erase Douyin's minimum in the one code path users actually trigger.

**A cool-down must outlive the process that detected it.** The strike count and expiry are
persisted (`sync.platformCooldown` in settings, read/validated by `src/sync/rateLimit.ts`), because
an MV3 service worker is torn down between syncs and the user clicking sync again is exactly when
the memory matters. The back-off doubles per consecutive signal and is capped, so a hostile
platform cannot lock itself out indefinitely. **A clean request clears it** — otherwise strikes
accumulate over a long session until the platform sits at the maximum for reasons that stopped
being true hours earlier.

Three consequences worth keeping:

- **Detecting the limit and then continuing to hammer the platform is worse than not detecting
  it.** A `rate_limit` result starts a cool-down, and the rest of that platform is skipped for the
  remainder of the run and subsequent runs.
- **Every sync entry point needs this.** `updateCreator` had the same platform set and paced it at
  a hard-coded 600 ms; a fix in the batch loop alone would have left it unprotected.
- Non-retryable errors in one platform must not stop the others: a cooling platform is skipped,
  not fatal.

**When a platform answers with a redirect, classify it.** Douyin responds to a burst with a
verification redirect; the tab then never renders a grid and the in-flight injection dies with
`Frame with ID 0 was removed`. That was classified `network`, which told the user nothing and —
worse — suppressed the rate-limit signal the sync layer needs in order to back off. The
observable fact is that the tab is no longer on the creator's profile, whatever it was moved to.

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

`twitter.ts` carried this claim:

> `display_text_range` is the `[0, end]` slice of `full_text` that is the author's text. X
> appends the media / quoted-tweet `t.co` URL to `full_text` but **excludes it from this
> range**…

The second half is wrong. `display_text_range` exists to exclude **leading @mentions**; on a
real media tweet it spans the whole string, appended link included. So a caption rendered as
`正文… https://t.co/xxxx`, and a short caption's title line — which is the body's first line —
became `caption https://t.co/…` in bold.

The expensive part is what the wrong belief did to the **test suite**: the fixture set
`display_text_range = [0, caption.length]`, i.e. it encoded the assumption as expected
behaviour. `strips the media link X appends to a caption` therefore passed for months while
every real payload leaked. Worse, the fixture's media entity had **no `url` field** — the very
value the correct fix keys on — so nothing in the suite could observe the difference.

**X's own clients do not use the range for this**: they take each media entity's `url` and
remove that exact substring. Do the same — it works whether or not the range happens to
exclude the link.

Rules that follow:

- **Never rely on an upstream field for a behaviour you have not measured.** If a comment says
  what an API does, it needs a fixture taken from a real payload behind it, or it is a guess
  wearing a citation.
- **A fixture must contain the fields the fix depends on.** Removing the entity `url` from the
  fixture silently made the whole area untestable; the fix and its test then agreed with each
  other and with nothing real.
- **Only remove what the payload says it appended.** Author-typed links live in
  `entities.urls`, never in a media entity, so they are never in the appended set. Stripping
  those would delete content the author wrote — and the repair rule must be equally narrow
  (stored text must *begin with* the fresh text and end in nothing but t.co links), because
  "starts with" alone would match any row the author continued writing.

**A payload's data is spread across levels, so a fix must survive being asked the wrong level.**
The same defect took three rounds because each round fixed one level and the retweet kept its
link:

1. the media chain ended two of its four branches at `...legacy.extended_entities` — an
   **object** — without reaching `.media`, so `Array.isArray` rejected it and a retweet whose
   media lived only on the retweeted status rendered nothing. The appended-link candidates come
   from those same entities, so the link had nothing to match and stayed;
2. `hasMedia` / `authorUrlCount` asked only the outer tweet. For a retweet that is exactly
   backwards — its media and its URLs are on the retweeted status — so the tweet most likely to
   end in an appended link was the one that claimed to have no media;
3. some payloads name the link nowhere at all (an outer media array carrying only
   `media_url_https`), which no entity-driven approach can cover.

Hence: collect **every** media array in the payload and let each consumer pick (display wants the
first non-empty; link stripping wants the union, because the text and the entities can come from
different levels), and keep a second, narrower pass for the payloads that name nothing — gated on
the two conditions that together make a trailing link provably not the author's (the tweet has
media, and `entities.urls` is empty).

**The user's own words are the best spec available.** "Some still have it, some don't" was the
whole diagnosis: it said the defect was conditional on the tweet's *shape*, and the screenshot
named the shape — the ones keeping the link were retweets. A report of "it works sometimes" is a
description of a condition to find, not a reason to test harder.

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

`chrome.scripting.executeScript` into a tab that navigates does **not** reliably reject. It can
resolve with **no result**, because the frame the script was running in is gone.

The old code read any resolution as success:

```ts
.then((r) => r?.[0]?.result === true).catch(() => false)
```

so a destroyed frame and a page that genuinely had no grid produced the same answer. That is what
made a real sync log say「作品网格在等待时间内未渲染」**3.5 seconds into a 10-second deadline** —
a sentence the probe is incapable of producing, because it only reports `false` when the deadline
expires. The log line was simply false, and it pointed at the page instead of at us.

- The injected functions here return a **boolean or an object** by construction, so "produced a
  value" is a sound test of "ran to completion". Classify rejected / valueless / successful
  separately (`InjectionOutcome`), and retry the valueless case — it is transient.
- **Retry the collector too, not just the readiness probe.** A collector always returns an object
  (an empty one for an empty grid), so no result is never data — yet it was reported as「未返回可
  解析的作品数据」, which reads exactly like "this creator has no works". Two very different
  conditions must not share a message.
- **A timing contradiction in a log is a bug report about the code, not the network.** "It gave up
  before its own deadline" is arithmetic, and it localizes the fault immediately. Read the
  numbers before theorizing about the platform.
- Retries are bounded (`INJECT_ATTEMPTS`) and the failure is still surfaced, so a page that keeps
  dying reports a real error instead of spinning.

**And check whether a diagnostic still means anything.** The Douyin tab-scan line appended a
warning whenever no Douyin tab was found — which is the ordinary case, since the handler opens
its own tab. It fired on nearly every sync and read as a problem when nothing was wrong. Once a
probe has answered its question, stop shipping it as an alarm.

---

## 24. Removing a guard needs a test on the guard, not on what it produced

I deleted Douyin's readiness probe and shipped it. The user caught it; the suite did not.

The reasoning looked sound at the time. The logs showed：

```
[DEBUG] 网格探针未完成，重试 1/2 | 注入未返回结果
[INFO]  douyin/uimi 同步完成 | 平台原始 10 条
```

— a probe that failed every attempt on a channel that then succeeded, so the probe looked
redundant, and "an async injection awaits, and the await is the window a navigation kills the
frame" made it look actively harmful. Two things were wrong with that:

- **The deep collector is async too, and works.** The general claim was refuted by a sibling
  function I could have checked in ten seconds. A theory that predicts a function's failure has
  to be tested against that function's successes.
- **The probe's value was its budget, and I replaced the budget, not the probe.** The wait was
  ~10s (a 10s probe deadline after an 800ms settle); the replacement was three attempts 700ms
  apart, ~1.4s. That is an 87% cut to the one thing the probe existed to provide — and it
  restores the original defect (a cold page whose grid has not rendered), which is what the
  probe was added to fix months earlier.

**412 tests stayed green.** They covered retry counts, error classification, tab lifecycle and
the ordering of wait-then-scrape — everything except the number that matters. A test that
"the probe is called before the scrape" passes just as happily when the probe waits 700ms.

Hence the rule: **when a guard's purpose is a magnitude (a timeout, a budget, a retry window),
assert the magnitude.** Presence and ordering are not the property; the quantity is. And when
the evidence for removing a guard is "it logged failures but the thing worked anyway", the
guard is doing its job loudly — check what it is *buying* before deleting it.

Corollary, learned the same hour: **a DEBUG line about a recoverable condition is not a bug
report.** The probe retrying and then succeeding is the system working. Treating that as a
defect to remove led to removing the guard itself.

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
12. CI (`.github/workflows/ci.yml`: typecheck + lint + vitest + build), 415 regression tests (hosts/senderGuard/FetchError/buildPost/backup validation/component SSR/dexie migration/image-cache probe/manual ordering/dev log), `typescript` pinned to 7.0.2; ESLint flat config added 2026-09 (`eslint.config.js`, TS6-compat alias for typescript-eslint); `vue-tsc` added 2026-09 so typecheck covers `.vue`; `release.yml` + tag/version gate added 2026-09; `jsdom` added 2026-09 for the RSS parse/sanitizer tests, which need a real `DOMParser`.
