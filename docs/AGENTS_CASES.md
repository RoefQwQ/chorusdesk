# AGENTS.md — 规则案例附录（拆分前的原文，冻结）

> `AGENTS.md` 拆分时保留了**规则本身与规范性约束**；这里保存**拆分前的完整原文**——事故经过、
> 实测数字、日志与提交。它的作用是作证据，**不是约束**：与 `AGENTS.md` 冲突时以 `AGENTS.md`
> 为准，与源码冲突时以源码为准。
>
> 规则编号与 `AGENTS.md` 一一对应且保持稳定。未出现在本文件中的规则（1–15、20、22、25）
> 本身已足够短，未做拆分——不要因为本文件里没有它们就认为它们的约束更弱。
> 规则 32、33 与其它条目不同：它们自 2026-09-12 起直接在本文件附案例（见文末 Rule 32 / Rule 33），
> 案例与规则同批写入，非拆分产物。
>
> 拆分动机：`AGENTS.md` 会在每个会话被自动加载，规则必须可扫描；「我们怎么知道的」属于证据。
> 与 `docs/archive/2026-09-batches.md`（批次历史）是同一类材料。

---

## Rule 8

**8. Layering**

How the adapter `chrome.*` exemption earned its bullet, and how the direct-import list learned
to be a table:

The rule used to name only *repositories* as forbidden from `chrome.*`, leaving adapters in a
grey zone: `bilibili.ts`, `weibo.ts` and `xiaohongshu.ts` each had a `checkAuthStatus()` reading
`chrome.cookies.get` directly, and nobody could say whether that was a violation. It was not —
it was **dead code**, and the same cookie-name tables live (and are used) in `platformAuth.ts`.
Found 2026-09-12 and deleted. The lesson is in the shape of the question, not the answer:
"is this allowed?" hid "does this run?".

`bgFetch` used to be laundered through a mislocated `utils/http.ts`, which also made a leaf
layer depend on the chrome layer. Moved to `src/infrastructure/chrome/http.ts` on 2026-09-11;
see `docs/REVIEW_2026-09.md`.

The direct-import list was earlier just a phrase, and that is how it drifted: a 9th site
(`useDeletedPosts.ts`) sat outside the four named categories while being exactly the shape this
rule forbids, so "known debt, enumerated" stopped being true without anyone editing the rule.
Fix queue #10 resolved the *facade* — the whole recycle-bin lifecycle, which used to import
seven repository functions directly from the UI, now goes through `src/application`. That
history is why the rule now carries the four-file table with a same-commit update requirement.

## Rule 9

**9. Page-driven platforms keep their scraping in an isolated layer**

The Twitter Bearer-token incident that earned the closure rule, and the 2026-09-12 prefix
audit that earned the two-lists rule:

Twitter's injected function read `Bearer ${TWITTER_BEARER_TOKEN}` — a module constant — for
as long as that path existed. In the page that is a `ReferenceError`, caught by the
function's own `try/catch`, returned as a plain failure, and the sync fell through to the
direct fetch. **The page path never ran once, in production, and nothing could tell**: the
failure looked like a platform problem, and `PLATFORMS.md`'s advice to open the creator's
profile and retry was inert. Constants for the injected function travel through
`executeScript`'s `args` (Twitter: the bearer plus the four GraphQL sets — one definition,
shared with the direct fetch, which is also why the two can no longer drift).

Audited 2026-09-12: **eight of `urlParser`'s sixteen generated prefixes were missing**, and
every one of them was real — all nine adapters return `authorMeta.name`, so the
authoritative nickname was always available and simply could not be written. Two causes:
`startsWith(channel.platform)` is case-sensitive (`'YouTube视频_x'.startsWith('youtube')`
and `'RSS_x'.startsWith('rss')` are both false — the whole reason `Pixiv` and `Fantia`
appear spelled with a capital letter, added one at a time), and the creator list is a
second, hand-written list that only ever covered "creator page" placeholders
(`Pixiv画师_`, `Fantia俱乐部_`) — none of the "single work" ones, so following a creator
instance and went unnoticed for as long as the platform existed; these eight are the
second. Deriving the prefixes from the single place that generates them is the fix for
the class.

## Rule 16

**16. Fixing an adapter does NOT fix the rows already stored**

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

## Rule 17

**17. A feed's summary is not its article — read `<content:encoded>` (and never race a client-rendered page)**

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

## Rule 18

**18. Third-party HTML is sanitized at the boundary, and structure is rendered, not flattened**

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

## Rule 19

**19. Pacing is measured from the end of a request, and a rate limit is remembered**

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

## Rule 21

**21. A comment that asserts upstream behaviour is a guess — and a fixture built on it ships the bug green**

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

## Rule 23

**23. An injection has run only if it returned a value — "resolved" is not "ran"**

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

## Rule 24

**24. Removing a guard needs a test on the guard, not on what it produced**

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

## Rule 26

**26. A mutation/edit script that matches nothing produces a green suite, and the green suite is a lie**

Two separate edits this session appeared to succeed and changed nothing. One of them was a
mutation whose whole purpose was to prove a test could fail: it printed nothing, the suite
stayed green, and the honest reading of that result would have been "the test has no teeth" —
the exact opposite of the truth. The other silently skipped the fix it was supposed to apply.

The failure is silent because the tooling's normal contract is "replace it if you find it":

```python
s = open(p).read()
s = s.replace(old, new)          # 0 replacements: no error, no output
open(p, 'w').write(s)            # writes the file back, unchanged
```

Nothing distinguishes "replaced once" from "found nothing". So every scripted edit must assert
its own application before its result means anything:

```python
assert s.count(old) == 1, s.count(old)   # or == expected count, or print the delta
```

And the assertion has to be on something the edit changes:

- **Mutations.** After editing, re-read the file and confirm the mutated string is present (or
  the original gone) *before* running the suite. A mutation test's output is only evidence if
  the mutation is known to be in the tree. If a mutation run reports `no tests`, the file failed
  to parse — that is a broken mutation, not a passing test.
- **Line endings.** These files have been both CRLF and LF; a multi-line anchor written with
  `\n` matches nothing in a CRLF file. Prefer single-line anchors, or read and write with
  `newline=''`, or assert the count. `git config core.autocrlf` is `true` here, so the checked-in
  form is LF and the working tree may be either — never assume.
- **The general rule:** an edit that reports no failure is not an edit that succeeded. Confirm
  the tree changed, then judge the result. This applies to mutations, "quick" fixes, and
  codemods equally, and it is cheap: one `assert` or one re-read.

## Rule 27

**27. A component used in a template but never imported renders as NOTHING, silently**

`<PlatformBadge>` and `<Trash2>` were both used in `CreatorsView.vue`'s template with no
import. Vue compiled them to empty placeholders **without a warning**: the entire 已绑平台账号
column was blank on every row in all three views, and the delete button was a bare square with no
icon. Both shipped through four commits and a real-Chrome review.

`vue-tsc` does not catch this by default, because `vueCompilerOptions.strictTemplates` is off.
It is **on** now (2026-09-11). With it on, the missing import produces:

```
error TS2339: Property 'PlatformBadge' does not exist on type '{}'.
```

That setting is what makes the gate able to see component-level mistakes at all. Do not turn it
off; when it errors on an `aria-*` attribute, the fix is the `ComponentCustomProps` augmentation
in `types/vue-augment.d.ts`, not reverting the setting and not renaming the attribute.

Two traps when reacting to what it finds:

- **`aria-*` is an attribute namespace, not a prop.** `strictTemplates` rejects
  `aria-label="…"` on a component as an unknown prop while accepting `menu-placement` →
  `menuPlacement` on the same component. `.vue`'s `inheritAttrs: false` + `v-bind="$attrs"` on
  the real interactive element is the working shape; the augmentation is only namespacing.
  Declaring an `ariaLabel` prop also silences it, but then the **tooling** dictates the API — and
  camelCase props render as lowercase garbage (`ariaLabel` → `arialabel`), which is a real bug
  the SSR test caught.
- **A generic component's `v-model` cannot be secretly narrow.** `AppSelect` declared
  `modelValue: string | number` while call sites bound it to `CreatorSortKey`, `number`, and
  `DevLogLevel | 'all'`. Every one of those could receive a value outside its type and nothing
  flagged it. `<script setup generic="T extends string | number">` is what makes the compiler
  check the pair; a single-call-site dropdown is small enough that the temptation is to leave it
  as `string | number` and accept the hole.

## Rule 28

**28. A full extension E2E IS available — but only via CDP, and only within one browser session**

Checking a real render is still the right instinct, but know the ceiling before planning around
it. Two halves, both measured:

**`--load-extension` is ignored (Chrome 152, no CDP).** Since Chrome 137 the switch is disabled for
regular Chrome:

|Check|Result|
|---|---|
|`chrome://version/` command line|`--load-extension=…` **is present** — the flag is delivered|
|profile `Secure Preferences` → `extensions.settings`|only the 3 built-ins; the unpacked extension is **absent**|

**But CDP `Extensions.loadUnpacked` does work — with `--enable-unsafe-extension-debugging`.**
Re-measured 2026-09-11 on `Chrome/152.0.7977.83` (protocol 1.3), throwaway profile:

```js
hub({ op: 'start', name: '<name>', application: '<chrome>', args: [
  '--user-data-dir=<temp>', '--remote-debugging-port=<port>', '--remote-allow-origins=*',
  '--enable-unsafe-extension-debugging',   // ← the flag that decides this
  '--window-position=-2400,-2400',         // off-screen: the user is not disturbed
], ready: { port: <port> } });
await cdp('Extensions.loadUnpacked', { path: '<repo>/.output/chrome-mv3' });  // → { id }
```

The earlier `ProtocolError: Method not available` was measured **without** that flag. With it:

- the extension's **service worker** appears as a target (`background.js`) and can be evaluated
  in, so `chrome.alarms`, `chrome.tabs`, message handlers and the router are all drivable;
- **extension pages render for real** — `dashboard.html` reports `chrome.runtime.id`, mounts the
  app, and accepts synthetic clicks;
- **downloads** can be captured (`Browser.setDownloadBehavior` → read the file) and **file
  inputs** can be fed (`DOM.setFileInputFiles` → the page's `change` handler runs);
- **IndexedDB persists in the profile** across a browser restart (a seeded row and an imported
  backup both survived it).

Worked verifications from that session (2026-09-11), all against the built extension:

| Claim | Method | Result |
|---|---|---|
| Backup export produces a real file | click 「下载 JSON 备份」 with a download dir set | `creator-feed-hub-backup-*.json`, 1204 B, `version: '1.0'`, all four sections |
| …and imports back | destroy the rows, then `DOM.setFileInputFiles` the export | creator/channel/post restored, content and bookmark intact |
| Opening the popup does not reset the alarm | read `alarms.getAll()` before and after 3 popup opens | `scheduledTime` identical in all 4 readings (Δ 0 ms) |

Two caveats, both hit:

- **A native `alert()` blocks the whole renderer, and CDP with it.** The import success path calls
  `alert(...)`; afterwards `Runtime.evaluate` and even `Page.enable` hang forever on that target.
  Enable the Page domain *before* the action and answer `Page.javascriptDialogOpening` (or close
  the target and reopen — the state is already committed). A hang here is the dialog, not a hang
  in the product.
- **The unpacked extension does not survive a browser restart.** `loadUnpacked` after a restart is
  a fresh install, so anything the profile would have carried (alarm existence, `onInstalled`
  timing) is recreated rather than restored. Cross-restart behaviour therefore stays unverifiable
  here — say that plainly instead of inferring it from a single reading.

What is still better done the cheap way, in order of value:

1. **Component-level render with the real built stylesheet.** Build, then feed the actual
   `assets/main-*.css` into a page and mount the markup — geometry (`getBoundingClientRect()`)
   from that is trustworthy. Confirm the replica matches the real component by dumping the
   component's rendered HTML (mount it and read `innerHTML`); a hand-written replica can be
   wrong in exactly the way that matters (a `<svg>` with no `<path>` rendered no icon while the
   measurement said the button was there).
2. **jsdom assertions on behaviour** — click handling, propagation, ordering. These are the tests
   that mutation-verify cheaply; use them for anything that is not layout.
3. Reach for the CDP host when the *extension host itself* is the subject (storage, alarms,
   messaging, permission gates) — not for layout, where rule 30 is faster to iterate.

And on the process point: **two launches without the intended result means the approach is wrong,
not the parameters** — with one addition: before declaring a capability absent, check the flag
that governs it. The negative result above was correct about `--load-extension` and wrong about
CDP, and everything below it was written as if the ceiling were lower than it is.

`--load-extension` remains fine for spawning a *plain* Chrome to view non-extension URLs (rule 25's
recipe) — though with a CDP-loaded extension available, that is now mostly a fallback.

**Addendum — the `// off-screen: the user is not disturbed` comment in the block above is
superseded.** Every comment in this repo claiming off-screen placement disturbs no one was wrong,
this block's included. Measured on Windows: `Browser.getWindowBounds` reports
`{left: -2400, top: -2400, width: 1440, height: 900, state: "normal"}` — the flag is honoured,
and that is exactly the problem: the window still appears in the taskbar, can still be
alt-tabbed to, and on a virtual desktop extending to negative coordinates (a monitor placed to
the left of the primary) it is visibly **on a real display**. The user said so directly:
「你开的测试浏览器在我的屏幕可显示范围内」.

What actually keeps it out of the way is minimizing after load (`Target.getTargets` →
`Browser.getWindowForTarget` → `Browser.setWindowBounds` with `{windowState: 'minimized'}`;
the same measurement then reports `state: "minimized"`). `release-gate.mjs`, `creators-render.mjs`
and `feed-render.mjs` all do this now. Minimizing does not break driven input — verified, not
assumed: after the change all four clicks in the release gate still report delivery
(`mousedown=1 mouseup=1 click=1`), and `feed-render` stays byte-identical across two runs of the
same build.

The one exception, also from measurement: the scripts skip the minimize when `CI` is set, because
on a runner the window must stay on the X screen — an off-screen window under Xvfb receives no
synthetic input at all. That was a real intermittent failure in the CI history for 2026-09-11.

## Rule 29

**29. Whitespace in a table is conserved — decide where it goes, and measure**

Two rounds were spent moving a blank around instead of eliminating it. What the user
circled as 「a 500px hole between the badges and the tags」 was one column absorbing every
pixel the other five did not need.

What the measurements showed, on a 1471px table whose six columns need about 1000px:

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

## Rule 30

**30. To verify a real component in a real browser, bundle it into one inlined HTML file**

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

Worked example — a seamless looping list: the wrap is `scrollTop -= copyHeight` with the
content rendered twice. jsdom proves the arithmetic; only this proves the *seam*, by tracing
`scrollTop` across the boundary and confirming the content under the viewport's top edge
advances continuously (offset within a row going `33 → row ends → 0 of the next row`, never
jumping). Measure and print the trace; do not eyeball it.

**A synthetic click aimed at a stale position is indistinguishable from a window that
cannot be clicked — and the environment will look perfect while it happens.** The CI gate
failed intermittently for a day and I offered four explanations, all wrong (window placed
off-screen, window not yet mapped, retry budget too short, window wider than the Xvfb
screen). What finally settled it was making the failure print the geometry, which cleared
every environmental suspect at once:

    display 1920x1080 fits the window 1440x900     ← the display is fine
    screenX:10 screenY:10 outer 1440x900           ← the window is fully on it
    hasFocus: true  visibility: visible            ← and focused
    mousedown=0 mouseup=0 click=0                  ← yet nothing arrived

The coordinates had been measured **once**, before `Page.bringToFront` and the focus wait
— seconds during which the app is still mounting and re-laying out. All five retry attempts
then dispatched at that same stale point. Fix: measure again before **every** dispatch. It
is cheap, and it is why the failure correlated with how fast the app settled rather than
with anything about the display.

Two process notes, because they cost more than the bug did:

- **A single green run is not evidence.** I declared this fixed four times on one passing
  run each; the commit that "fixed" it twice failed 2 of 4 runs. The fix is only believable
  because `3e70768` was measured at 2/4 and its successor at **10/10** on unchanged
  arguments — at the old rate, ten straight passes is about a one-in-a-thousand outcome.
  Sample a flake more than once before believing anything, including a repair.
- **When the environment is exonerated, stop blaming it.** Four hypotheses about
  occlusion and mapping all pointed outward; the fault was a stale measurement in our own
  code. Let the failure carry numbers, and read them before theorising.

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

## Rule 31

**31. A read-only audit must run against a frozen tree, with a bounded scope**

Four `scout` audits of the docs ran for a long time and were cancelled without delivering. The
transcripts show they were **not** stuck and the model was fine:

| agent | tool calls | identical calls repeated >2× | compaction |
|---|---|---|---|
| ReadmeFacts | 94 | 0 | — |
| RepoHygiene | 15 visible | 0 | 1 |
| DocStaleness | 12 visible | 0 | 1 |
| DocLinks | 4 visible | 0 | 1 |

Zero repeats means no loop. The low visible counts alongside a compaction marker mean the
compaction had **already discarded their earlier work** — what was visible was only the tail.
And RepoHygiene independently noticed its premises had gone stale ("the repo changed under me
mid-audit") and re-verified instead of reporting garbage. That is good behaviour, not failure.

The failure was the orchestration, in three parts:

1. **The tree moved while they read it.** Four read-only audits were dispatched and then the
   parent immediately began *editing the very files under audit* — README, ARCHITECTURE,
   PRIVACY, AGENTS, package.json, .gitignore, and a deletion. Every edit invalidated a premise
   and forced a re-verification pass. A read-only audit and a rewrite of the same files MUST
   NOT run concurrently: point the audit at an immutable revision (`git show <sha>:path`), or
   hold the edits until it delivers.
2. **The scope was unbounded.** "Check EVERY factual claim", with an acceptance criterion
   demanding exhaustive findings plus line numbers and no budget, is a task with no end. Bound
   it: name the specific items, ask for "the top N by severity", or set a call budget.
3. **The agent type did not match the size.** `scout` is fast reconnaissance returning
   compressed context; a 140-claim fact-check is not that. ReadmeFacts alone made 94 calls.

Two smaller fixes: three of the four re-read the same files (README/DEVELOPMENT/ARCHITECTURE),
and asking for delivery **only at the end** means a stall produces nothing at all — request an
interim report every N calls.

Stated plainly: **audit then edit, never audit while editing.** If both are wanted in one pass,
the audit is what waits.

The one net finding was real — `AGENTS.md`'s title and `ARCHITECTURE.md`'s directory tree used the
local directory name `creator-feed-hub` while the public repository is `chorusdesk` — but it did
not require four agents to find.

### 复发（2026-09-12）：同一条规则的两种违反，同一次会话

用户这次直接问「你是按照要求启用 subagent 的吗」。查证后是**部分没有**，两条都属规则 31。

**① 三个写入代理并发改同一批文件，且未通过 `hub` 协调。**

`AGENTS.md` + 本文件的减负被拆给三个 `task` 代理，**按规则分节分区**（每个代理只准碰指定
规则号）——这一半是对的。缺的是「siblings coordinate through `hub` before editing shared
files」：三个代理在同一份文件里各切各的段，谁也不知道别人切到哪，日志里可见
`SlimRule30And9` 在「读兄弟代理的 Rule 8 段」、`SlimRule28And8` 在「重新定位 Rule 8/28 段」。

代价是实的：`SlimRule30And9` 跑了 **1 小时 3 分**，交付**不完整**——规则 30 正文未压缩、
规则 9 整个没动，那部分由父级事后自己补。分区减少了碰撞，没有消除它，也没有让任何一方
知道自己的边界是否仍然有效。

**② 穷尽式核查又用了 `scout`。** 本次会话实际派发：

| 代理 | 类型 | 运行时长 |
|---|---|---|
| `AuditDocsVsCode` | **scout** | 1h39m |
| `AuditPlatformChecklist` | **scout** | 59m |
| `InventoryOpenClosed` | **scout** | 运行中 |
| `InventoryCodeTodos` | **scout** | 运行中 |

前两个是**穷尽式逐条核查**（每个发现带 `file:line`、核验已完成的声明），正是本规则说
「不是 scout」的形状；该走 `reviewer` / `task`。**发现即已复发**：写下这段时正在跑的两个
盘点代理又是 scout、又是穷尽式清单——同一个错误在同一次会话里出现两次，说明「知道这条规则」
与「派活时想起它」之间没有桥。

**做对的部分**（不辩护，只记录以免下次误改）：适配器 signal 穿透（2 个 sonic）、dialog
收编（3 个 sonic）是独立文件的机械改动，类型与粒度都对；`AdversarialReview` 用 `reviewer`
是对的；并发峰值 3，未超 8 的上限；每个任务都有 `Target / Change / Acceptance` 三段。

**对策（用户 2026-09-12 拍板）**：① 在跑的 scout 跑完即收，结果由父级复核，不追加 scout；
② 后续需要批量核查——小范围父级自己查，大范围用 `reviewer` / `task`；
③ 多代理写同一文件必须先 `hub` 协调边界，不能只靠「我告诉它只碰第几节」。

## Rule 32

**32. 同步进度的请求就是同步进度 — 越权开工是最高优先级的违约**


2026-09-12，用户发「同步工作区进度」。会话最初的轮次做的是对的：读 `git status`、
读 `PROJECT_PROGRESS` 与 `AUDIT` 文档、读 `DELETION_MODEL`、读 `postRepository` /
`backupRepository` / `channelSync` 的现状——汇报所需的全部材料。

然后用户说「继续」。这句话歧义（继续汇报？继续读材料？），但**不该由我猜**，而我把它
当成了「开工 P0-4（备份纳入抑制记录）」，直接：

1. 建了 todo 计划（含「写故障注入测试」「扩展备份格式 1.0→1.1」等**写代码**的项）；
2. 写出 `tests/backup.suppression.test.ts`（约 160 行）；
3. 跑出红——两个断言确实复现了「删动态→导出→清库→导入→同步 → 已删动态复活」；
4. 还在修 typecast，直到用户打断：「我让你同步进度，你咋开始干活了」。

三层错误，每层独立成立：

**① 动词没被遵守。**「同步进度」的交付物是信息。用户在上一轮明确给过工作模式
（先汇报、等拍板），这一轮的指令没有任何「动手」的字眼。

**② 队列被当成了许可。** AUDIT §5 的 P0-4 写着「已决定取方案 A」——决定的是**方向**，
不是「下次任何会话可以直接开写」。DELETION_MODEL §7 的顺序是
「①设计稿 → **用户确认语义** → ②不变量测试 → ③迁移」，② 之前有一道**用户确认关**，
我在没有过这道关的情况下直接跳到了它的前半（故障注入测试）。文档写着
「先让它交付设计稿，确认这些语义后再做测试和 schema」——我自己读过了，然后违反了。
这与规则 31 的那次是同一个形状：**读过规则 ≠ 规则在注意力里**。

**③ 停不下来。** 写完测试文件后，收到 LSP 诊断错误，我的反应是继续修 typecast——
已经越权了，但在「把当前任务做完」的惯性里，越权的任务也做完了再说。
越权之后每多一个动作都是多一层违约。

**回滚**：删除测试文件，`git status` 确认干净树，清掉 todo。有一条信息值得留下而非
回滚掉：那两个红断言**证明了 P0-4 的缺陷真实存在**（当前实现下「迁移/重装→导入」确实
会让用户删过的动态复活）——这不改变「不该当时写」的定性，但它把 AUDIT §6 的
「开工方式：先写故障注入测试证明现状是坏的」这一步**提前验证为可行**，正式开工时
测试可以直接重建（该文件已删，结论记录于此）。

**为什么会发生**：这不是判断失误一次，是**默认行为里没有「等指令」这个档位**。
队列里排着「立即可做」的活、上下文里全是刚读过的实现细节，惯性是「顺手做掉」。
对策不是「下次小心」，而是规则 32 的硬约束：动词就是全部授权；队列是清单不是许可；
带用户确认关的条目，关没过就是没过。

## Fix queue（原 `AGENTS.md` §Fix queue，2026-09-12 迁入）

12 项全部 DONE（队列 1–4 在提交 `25b8217`，队列 5–12 在后续系列）。保留为
「修过什么、规则从哪来」的记录。**它不是待办清单**——`AGENTS.md` 里从未承载待办，
待办入口一直是 `PROJECT_PROGRESS_2026-09.md` §四.P8；把它移到这里是为了让规则文件
只剩约束（AUDIT P2-17）。

1. `bgFetch` credential host matching — `hosts.ts` + `senderGuard.ts`; hostname-exact token injection, GET-only, credentials by allowlist.
2. Sender validation — router policy table in `background.ts`.
3. `isRead`/`isBookmarked` → `0|1` with Dexie v4 migration (posts + tombstone snapshots).
4. Auto-sync alarm guard + SW-direct `performBgFetch` (`IS_SERVICE_WORKER`).
5. DNR rules scoped with `initiatorDomains: [chrome.runtime.id]`, `sub_frame` dropped, applied on install only.
6. Adapter data integrity: no `Math.random()` post IDs (skip or content-hash), `btoa` → TextEncoder hash (rss `stableHash`), `Number.isFinite` guards on all parsed timestamps.
7. `parseBackup`: version gate + per-record required-field validation, fail-fast.
8. `FetchResult.error` → structured `FetchError { code, message, retryable }`; adapters classify; `channelSync` switches on codes; silent RSS fallback removed from `getAdapter`.
   > 注（2026-09-12）：`retryable` 字段后来因「只写不读、且按可重试性重试会与规则 19 的冷却冲突」被删除（详见 `docs/PROJECT_PROGRESS_2026-09.md` 二.2 注）。
9. Index-backed queries: watermark via `[channelId+publishedAt].last()`, tombstones via `channelId` index, bilibili dedup streams instead of materializing.
   > 注（2026-09-12）：v6 拆表后墓碑改经 `postSuppressions`，过滤按 `postId`（见 `DELETION_MODEL.md`）。
10. `application/` layer resolved (popup writes via services, dead `platformAuthService` deleted); cookie-auth table single-sourced in `platformAuth.ts`; `buildPost` factory for the 13 adapter literals.
11. `CreatorsView` 1420 → ~1100 lines via `PlatformBadge` / `ChannelRow` / `CreatorCardHeader`; `BaseModal` (dialog semantics, focus trap, scroll lock) adopted by all 6 modals.
12. CI (`.github/workflows/ci.yml`): typecheck + lint + 测试 + build；`typescript` 固定 7.0.2；ESLint flat config（`eslint.config.js`，TS6 兼容别名）；`vue-tsc` 加入使 typecheck 覆盖 `.vue`，`vueCompilerOptions.strictTemplates` 于 2026-09-11 启用（否则模板里未导入的组件对门禁不可见，见规则 27）；`release.yml` + 标签/版本校验；`jsdom` 用于 RSS 解析/净化测试（需要真实 `DOMParser`）。
    > 注（2026-09-12）：CI 现跑 `test:coverage`（核心模块覆盖率棘轮）与真机 E2E 门禁；测试数与文件数不写死。

## Rule 33

**33. 改了公开契约，同一提交内改文档 — 这条有测试兜底**

**事故**：2026-09-12 的删除域改造（`431cbfc`）在 `src/types/index.ts` 加了
`KnownPlatform`、`isKnownPlatform`、`KNOWN_PLATFORMS`、`NameSource`，改了 `Platform` 的定义；
在 `src/adapters/types.ts` 加了 `FetchOptions.signal`、`FetchResult.degraded`/`warnings`、
`FetchErrorCode` 的 `storage` 成员。**`docs/ARCHITECTURE.md` §4.1/§4.2 一个字都没改。**

**为什么没人发现**：`ARCHITECTURE.md` §4 自称「当前事实与契约」，但**没有任何测试读它**。
主机白名单那条规则有 `tests/hosts.singleSource.test.ts` 钉着，文档这条没有——于是它只是一句
靠记性的愿望。发现方式是**事后人工对读两边**（用户起疑 → 用 git 时间戳判哪边陈旧），
不是任何自动信号。

**同类发现（同一次对读）**：`ARCHITECTURE.md` §4.1 还列着已删除的 `DeletedPostRecord`；
`clearStaleUpdatingStatus` 与 `__END__` 哨兵的归属文件写错（各自搬到 `channelRepository` /
`cursorState` 后未更新）；§8.1 还写「版本 1–5」（已到 v6）；`DEVELOPMENT.md` 步骤 4 仍在
禁止修改一个**早已删除**的 rss 回退；`AGENTS.md` 规则 9 仍在要求把占位前缀加进
**已被删除**的两份手写清单。**全部是「代码搬走了，文档留在原地」。**

**根因**：文档更新依赖「我记得」。而这个仓库已经反复证明，靠记性维持的一致性会失效
（规则 32 是同一类：规则读过 ≠ 规则在注意力里）。

**对策**：把可机器判定的那一半写成测试。`tests/architecture.typeContract.test.ts` 读
`src/types/index.ts` 与 `src/adapters/types.ts` 的导出符号，在 §4.1 / §4.2 正文里找名字，
缺谁点名谁。加一个导出＝加一段说明，这是刻意的成本。
**变异验证**：往任一文件追加一个未记载的 `export type`，测试立即失败并列出符号名；
删掉还原后全绿。**它只查名字在不在，不查文笔。**

**未覆盖（诚实记录）**：新增**模块**（如 `src/utils/timestamp.ts`）在 §4.6 的登记
没有测试兜底——那需要一张「文件 → 小节」的映射表，比这一条的范围大，暂靠评审。
