/**
 * The page-side xiaohongshu profile collector.
 *
 * Injected into a real xiaohongshu.com tab by `messages/xiaohongshuNotes.ts` via
 * `chrome.scripting.executeScript`. It must therefore be **self-contained**: no
 * imports, no closure over module scope, no `chrome.*`. Everything it needs is a
 * parameter, a local, or a page global — `tests/xiaohongshu.collector.injected.test.ts`
 * evaluates its SOURCE with no closure to keep that true (AGENTS rule 9).
 *
 * ## Why the page at all
 *
 * A `bgFetch` of a profile page returns the SSR document, which carries only the
 * FIRST SCREEN — measured 2026-09-13 on a real profile: 30 notes, with
 * `user.noteQueries[0]` reading `{ num: 30, hasMore: true, cursor: "69fdde80…" }`.
 * So the platform says there are more and we cannot reach them from the worker:
 * the endpoint that would (`/api/sns/web/v1/user_posted`) needs an `X-S`
 * signature only the page's own JS produces, and taking that route is excluded by
 * `docs/DOUYIN_RESEARCH_2026-09.md` (signing is incompatible with this project's
 * position).
 *
 * What is left is what the user asked for and what the reference implementation
 * (JoeanAmier/XHS-Downloader) does: **scroll the page and read the state it has
 * already loaded.** This reads `window.__INITIAL_STATE__` — the same object the
 * adapter already parses out of the SSR HTML — after the page's own lazy loader
 * has appended to it. Nothing is signed, forged, or derived from device state.
 *
 * ## That reference also states the risk, and we must repeat it
 *
 * Its README says auto-scrolling is **off by default** because 「启用该功能可能会被
 * 小红书检测为自动化操作，从而导致账号受到风控或封禁风险」. The behaviour below is
 * modelled on theirs deliberately — small `scrollBy` increments, randomised pacing,
 * occasional pauses — but the risk is the user's account, not ours, so the deep-sync
 * flow warns before it runs (see `useDeepSync`).
 */

/** One note as the page's state holds it, reduced to the fields the adapter maps. */
export interface RawXhsNote {
  id: string;
  xsecToken: string;
  title: string;
  type: string;
  time: number;
  likedCount: string;
  nickname: string;
  avatar: string;
  coverUrl: string;
  noteUrl: string;
}

/** What the collector returns. Mirrors the validated shape in `contract.ts`. */
export interface XhsProfileSnapshot {
  userId: string;
  authorName: string;
  authorAvatar: string;
  notes: RawXhsNote[];
  /** True when scrolling stopped producing new notes. */
  saturated: boolean;
  /** Total the profile header states, when present. Includes hidden works. */
  statedTotal: number | null;
  /** True when the page is showing a login wall instead of a profile. */
  requiresLogin: boolean;
}

/**
 * Scroll the profile's note list and return everything the page has loaded.
 *
 * `maxItems` bounds what is RETURNED; `maxScrolls` bounds how long we keep asking.
 * Both are parameters rather than constants because the caller knows the user's
 * budget and the platform's tolerance, and this function must stay self-contained.
 *
 * The page's scroller is NOT the window: xiaohongshu keeps its feed in an inner
 * container, and driving `window` alone is the mistake AGENTS rule 10 records
 * (it looks exactly like "this page cannot paginate"). So every scrollable
 * ancestor of the note list is driven, plus the window, and the last card is
 * scrolled into view — which is what the lazy loader actually watches.
 */
export async function collectXhsProfileNotes(
  maxItems: number,
  maxScrolls: number,
): Promise<XhsProfileSnapshot> {
  // EVERY constant lives here, not at module scope. `executeScript` serializes this
  // function alone, so a module-scope reference is an undefined identifier in the
  // page — the failure mode recorded in AGENTS rule 9 (Twitter's bearer token), which
  // is invisible unless the function's SOURCE is evaluated without its closure. The
  // injected test does exactly that, and caught these on the first run.

  /** Smallest/largest single scroll step, in px. Matched to the reference impl. */
  const SCROLL_MIN = 100;
  const SCROLL_MAX = 300;
  /** Pacing between steps, in ms. */
  const STEP_MIN_MS = 250;
  const STEP_MAX_MS = 500;
  /** Probability of an extra pause between steps, to avoid a perfectly even cadence. */
  const PAUSE_CHANCE = 0.2;
  /** Quiet rounds after which the grid is treated as done growing. */
  const STAGNANT_ROUNDS = 3;
  /** How long to wait for a scroll to produce more notes before judging it quiet. */
  const SETTLE_MS = 900;

  const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '';

  /** The page's own state object. Absent when the URL is not a profile page. */
  const readState = (): Record<string, unknown> | null => {
    const w = window as unknown as Record<string, unknown>;
    const state = w.__INITIAL_STATE__ as Record<string, unknown> | undefined;
    if (!state || typeof state !== 'object') return null;
    return state;
  };

  /** The notes arrays the state carries, across the shapes a profile uses. */
  const readNoteGroups = (): unknown[][] => {
    const state = readState();
    if (!state) return [];
    const user = (state.user ?? {}) as Record<string, unknown>;
    const container = user.notes;
    const groups: unknown[][] = [];
    // The profile nests them one level (`notes: [[…]]`); other variants hand back a
    // bald array of notes. Accept both rather than assuming, and never index past
    // what is there — `_rawValue` is a MobX wrapper the page uses internally.
    const candidate = (container as Record<string, unknown> | undefined)?._rawValue ?? container;
    if (Array.isArray(candidate)) {
      // A bald array: every element is a note, so treat the whole thing as one group.
      const nested = candidate.some((g) => Array.isArray((g as Record<string, unknown> | undefined)?._rawValue ?? g));
      if (!nested) {
        groups.push(candidate as unknown[]);
      } else {
        for (const group of candidate) {
          const g = (group as Record<string, unknown> | undefined)?._rawValue ?? group;
          if (Array.isArray(g)) groups.push(g as unknown[]);
        }
      }
    }
    return groups;
  };

  const countNotes = (): number => {
    let n = 0;
    for (const group of readNoteGroups()) {
      for (const item of group) {
        const rec = item as Record<string, unknown> | null;
        const card = (rec?.noteCard ?? {}) as Record<string, unknown>;
        if (!isEmpty(rec?.id) || !isEmpty(card.noteId)) n++;
      }
    }
    return n;
  };

  /** Drive every scrollable ancestor of the note list, then the window. */
  const scrollOnce = (): void => {
    const step = SCROLL_MIN + Math.floor(Math.random() * (SCROLL_MAX - SCROLL_MIN + 1));
    // Find the list through the DOM so we can walk up from it; the state object
    // has no element reference.
    const anchor =
      document.querySelector('section.note-item, .note-item, [data-v-a264b01a]') ??
      document.querySelector('.feeds-container, .user-posted, #userPosted, .note-list');
    if (anchor) {
      let node: HTMLElement | null = anchor as HTMLElement;
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) {
          node.scrollTop = Math.min(node.scrollTop + step, node.scrollHeight);
        }
        node = node.parentElement;
      }
    }
    window.scrollBy(0, step);
  };

  const sleep = (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  };

  // A login wall serves a different document; say so instead of reporting an
  // empty profile (rule 13: a zero result must name why).
  const requiresLogin = /\/login/.test(location.pathname) || Boolean(
    document.querySelector('.login-container, .login-box, #login-container'),
  );

  let previous = countNotes();
  let saturated = false;

  if (!requiresLogin) {
    let stagnant = 0;
    for (let round = 0; round < maxScrolls; round++) {
      if (previous >= maxItems) break;
      scrollOnce();
      if (Math.random() < PAUSE_CHANCE) await sleep(STEP_MIN_MS + Math.floor(Math.random() * (STEP_MAX_MS - STEP_MIN_MS)));
      await sleep(SETTLE_MS);

      const current = countNotes();
      if (current <= previous) {
        stagnant++;
        if (stagnant >= STAGNANT_ROUNDS) {
          saturated = true;
          break;
        }
      } else {
        stagnant = 0;
        previous = current;
      }
    }
  }

  // Reduce in the page: only these fields cross the boundary, so a huge state
  // object never becomes a huge message.
  const notes: RawXhsNote[] = [];
  const seen = new Set<string>();
  for (const group of readNoteGroups()) {
    for (const item of group) {
      if (notes.length >= maxItems) break;
      const rec = (item ?? {}) as Record<string, unknown>;
      const card = (rec.noteCard ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      const id = str(rec.id) || str(card.noteId);
      if (!id || isEmpty(id) || seen.has(id)) continue;
      seen.add(id);

      const cover = (card.cover ?? {}) as Record<string, unknown>;
      const infoList = Array.isArray(cover.infoList) ? cover.infoList : [];
      const firstInfo = (infoList[0] ?? {}) as Record<string, unknown>;
      const user = (card.user ?? {}) as Record<string, unknown>;
      const coverUrl =
        str(cover.urlDefault) || str(cover.urlPre) || str(firstInfo.url) || str((card.image as Record<string, unknown> | undefined)?.url);

      notes.push({
        id,
        xsecToken: str(card.xsecToken) || str(rec.xsecToken),
        title: str(card.displayTitle) || str(card.title),
        type: str(card.type),
        time: typeof card.time === 'number' ? card.time : 0,
        likedCount: str((card.interactInfo as Record<string, unknown> | undefined)?.likedCount),
        nickname: str(user.nickName) || str(user.nickname),
        avatar: str(user.avatar),
        coverUrl,
        // Canonical work page, with the token the note needs to be viewable.
        // Assembled here because the page knows both; the adapter must not have to.
        noteUrl: str(card.xsecToken) || str(rec.xsecToken)
          ? `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(str(card.xsecToken) || str(rec.xsecToken))}&xsec_source=pc_user`
          : `https://www.xiaohongshu.com/explore/${id}`,
      });
    }
  }

  // The profile header's own count, when it states one. Includes works the author
  // has hidden, so it is a one-way signal only (rule 10) — never "we are missing
  // this many".
  //
  // ONLY a plain integer is accepted. A big creator's header is abbreviated
  // (「作品 1.2万」), and `/作品\s*(\d+)/` read that as **1** — which would make
  // `notes.length >= statedTotal` true on the first page and write `__END__`,
  // permanently blocking a dig that had barely started (rule 10's unrecoverable
  // direction). An abbreviated or absent count is therefore `null` = "unknown",
  // and unknown can never be positive evidence of completeness.
  const statedTotal = ((): number | null => {
    const match = (document.body?.innerText ?? '').match(/作品\s*([\d.,]+)\s*(万|亿)?/);
    if (!match) return null;
    // Any unit suffix means the displayed number is rounded, so the exact total is
    // unknowable from it. Treat it as unknown rather than guessing a floor.
    if (match[2]) return null;
    const plain = match[1].replace(/,/g, '');
    // `1.2` without a unit is not a count either; refuse rather than truncate.
    if (!/^\d+$/.test(plain)) return null;
    const value = Number(plain);
    return Number.isFinite(value) && value > 0 ? value : null;
  })();

  const state = readState();
  const user = ((state?.user ?? {}) as Record<string, unknown>);
  const pageData = ((user.userPageData ?? {}) as Record<string, unknown>);
  const basicInfo = ((pageData.basicInfo ?? {}) as Record<string, unknown>);
  const str2 = (v: unknown): string => (typeof v === 'string' ? v : '');

  return {
    userId: str2(user.userId) || str2(user.redId),
    authorName: str2(basicInfo.nickname) || notes[0]?.nickname || '',
    authorAvatar: str2(basicInfo.imageb) || str2(basicInfo.images) || notes[0]?.avatar || '',
    notes,
    saturated,
    statedTotal,
    requiresLogin,
  };
}
