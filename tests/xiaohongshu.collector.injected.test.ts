// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectXhsProfileNotes } from '../src/adapters/xiaohongshu/collector';
import { normalizeXhsSnapshot } from '../src/adapters/xiaohongshu/contract';

/**
 * The xiaohongshu collector, tested the way `chrome.scripting` actually runs it.
 *
 * `executeScript({ func })` serializes the function with
 * `Function.prototype.toString()`, so it carries NO closure: a reference to a
 * module-scope identifier is an undefined name in the page. Calling the function
 * OBJECT keeps the closure and passes, which is exactly how the Twitter bearer
 * bug shipped green (AGENTS rule 9). So the helper below evaluates the SOURCE.
 *
 * The page state is the real shape measured 2026-09-13 from a live profile
 * response: `notes` is one level of nesting (`[[…]]`), each item carries `id` and
 * `xsecToken`, and `noteCard` holds the display fields. The count assertions use it
 * rather than a shape invented to match the parser (rule 15).
 */

/** Build the page's `__INITIAL_STATE__` for a profile with `count` notes. */
function profileState(count: number, opts: { nest?: boolean } = {}) {
  // 24 lowercase hex characters, the shape a real note id has. Built as text: a
  // 24-hex literal exceeds 2^53, so numeric arithmetic would corrupt it.
  const noteId = (i: number): string =>
    `6a${i.toString(16).padStart(2, '0')}${'0'.repeat(18)}${(i % 256).toString(16).padStart(2, '0')}`.slice(0, 24);
  const notes = Array.from({ length: count }, (_, i) => ({
    id: noteId(i),
    xsecToken: 'ABsharedTokenAcrossNotes=',
    noteCard: {
      noteId: noteId(i),
      displayTitle: `笔记 ${i}`,
      type: 'normal',
      time: 1_700_000_000_000 - i * 1000,
      xsecToken: 'ABsharedTokenAcrossNotes=',
      interactInfo: { likedCount: String(100 + i) },
      user: { nickName: '示例博主', avatar: 'https://sns-avatar-qc.xhscdn.com/a.jpg' },
      cover: { urlDefault: `https://sns-img-qc.xhscdn.com/note${i}.jpg` },
    },
  }));
  return {
    user: {
      userId: '63799a52000000001f01ca92',
      userPageData: { basicInfo: { nickname: '示例博主', imageb: 'https://sns-avatar-qc.xhscdn.com/a.jpg' } },
      notes: opts.nest === false ? notes : [notes],
    },
  };
}

/** Run the collector through its SERIALIZED source — no closure, like the page. */
async function runInjected(maxItems: number, maxScrolls = 0) {
  const source = collectXhsProfileNotes.toString();
  const isolated = new Function(`return (${source})`)() as typeof collectXhsProfileNotes;
  return await isolated(maxItems, maxScrolls);
}

function setState(state: unknown) {
  (window as unknown as Record<string, unknown>).__INITIAL_STATE__ = state;
}

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).__INITIAL_STATE__;
  // No scrolling by default: these cases are about reading, and maxScrolls 0 makes
  // the loop a no-op. The scroll cases set their own.
  document.body.innerHTML = '<div class="feeds-container"></div>';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('xiaohongshu collector — reading the page state', () => {
  it('runs with no closure', async () => {
    setState(profileState(3));
    // This is the whole point of the helper: if the source referenced module scope,
    // this would throw `ReferenceError` exactly as it would in the page.
    await expect(runInjected(10)).resolves.toBeTruthy();
  });

  it('reads every note, flattening the nested groups', async () => {
    setState(profileState(5));
    const snap = await runInjected(10);

    expect(snap.notes).toHaveLength(5);
    expect(snap.notes.map((n) => n.title)).toEqual(['笔记 0', '笔记 1', '笔记 2', '笔记 3', '笔记 4']);
  });

  it('accepts a bald array as well as the nested one', async () => {
    // Measured variants differ here; the collector must not assume only one shape.
    setState(profileState(4, { nest: false }));
    const snap = await runInjected(10);

    expect(snap.notes).toHaveLength(4);
  });

  it('carries the author and the profile id', async () => {
    setState(profileState(2));
    const snap = await runInjected(10);

    expect(snap.userId).toBe('63799a52000000001f01ca92');
    expect(snap.authorName).toBe('示例博主');
    expect(snap.authorAvatar).toContain('xhscdn.com');
  });

  it('builds a note link that carries the token the note needs', async () => {
    // The tokenless form 404s with error_code=300031 — the reported bug. The page
    // knows both halves, so the collector assembles the URL and the adapter does not
    // have to.
    setState(profileState(1));
    const snap = await runInjected(10);

    expect(snap.notes[0].noteUrl).toContain('/explore/');
    expect(snap.notes[0].noteUrl).toContain('xsec_token=ABsharedTokenAcrossNotes%3D');
    expect(snap.notes[0].noteUrl).toContain('xsec_source=pc_user');
  });

  it('caps the result at maxItems', async () => {
    setState(profileState(20));
    const snap = await runInjected(6);

    expect(snap.notes).toHaveLength(6);
  });

  it('reports a login wall instead of an empty profile', async () => {
    // A clean browser gets redirected here; the caller must be able to say so
    // rather than reporting "this account has no notes" (rule 13).
    setState(profileState(0));
    // Patched and restored around this case only: `window.location` is shared by
    // every test in the file, and leaving it on `/login` silently skipped the
    // scroll loop in the cases below (they passed alone and failed together).
    const real = window.location;
    Object.defineProperty(window, 'location', {
      value: { pathname: '/login', href: 'https://www.xiaohongshu.com/login' },
      writable: true,
      configurable: true,
    });
    try {
      const snap = await runInjected(10);
      expect(snap.requiresLogin).toBe(true);
    } finally {
      Object.defineProperty(window, 'location', { value: real, writable: true, configurable: true });
    }
  });
});

describe('xiaohongshu collector — validation at the boundary', () => {
  it('drops a note with no id, a bad time, or no link', async () => {
    // Each of these would otherwise reach the db as a post the user cannot open or
    // that sorts to 1970. Rejection is per note, so the good ones survive.
    const state = profileState(1);
    (state.user.notes as unknown[][])[0].push(
      { id: '', noteCard: { displayTitle: 'no id', time: 1_700_000_000_000 } },
      { id: '6a0000000000000025037cff', noteCard: { displayTitle: 'no time', time: 0, xsecToken: 't' } },
    );
    setState(state);

    const snap = await runInjected(10);
    const validated = normalizeXhsSnapshot(snap);

    expect(validated).not.toBeNull();
    expect(validated!.notes.map((n) => n.title)).toEqual(['笔记 0']);
  });

  it('rejects a snapshot that is not a profile at all', () => {
    expect(normalizeXhsSnapshot(null)).toBeNull();
    expect(normalizeXhsSnapshot('nope')).toBeNull();
    expect(normalizeXhsSnapshot({ notes: [] })).toBeNull(); // no id, no notes
    expect(normalizeXhsSnapshot({ userId: 'x', notes: 'not-an-array' })).toMatchObject({ notes: [] });
  });

  it('rejects a non-http media or note URL', () => {
    const snap = {
      userId: 'u1',
      notes: [
        {
          id: '6a0000000000000025037c00',
          time: 1_700_000_000_000,
          noteUrl: 'javascript:alert(1)',
          coverUrl: 'data:image/png;base64,AAAA',
        },
      ],
    };
    // The note is dropped outright: a post whose click target is not http(s) has
    // nothing the user can open.
    expect(normalizeXhsSnapshot(snap)!.notes).toHaveLength(0);
  });

  it('caps field lengths rather than trusting the page', () => {
    const snap = {
      userId: 'u1',
      notes: [
        {
          id: '6a0000000000000025037c00',
          time: 1_700_000_000_000,
          noteUrl: 'https://www.xiaohongshu.com/explore/6a0000000000000025037c00',
          title: 'x'.repeat(5000),
          xsecToken: 'y'.repeat(5000),
        },
      ],
    };
    const note = normalizeXhsSnapshot(snap)!.notes[0];

    expect(note.title.length).toBe(500);
    expect(note.xsecToken.length).toBe(512);
  });
});

describe('xiaohongshu collector — scrolling', () => {
  it('grows the result as the page appends notes', async () => {
    // The lazy loader appends to the state; the collector must re-read it each
    // round rather than snapshotting once.
    setState(profileState(2));
    let calls = 0;
    const original = window.scrollBy;
    window.scrollBy = (() => {
      calls++;
      setState(profileState(2 + calls * 2));
    }) as typeof window.scrollBy;

    const snap = await runInjected(10, 3);
    window.scrollBy = original;

    expect(calls).toBeGreaterThan(0);
    expect(snap.notes.length).toBeGreaterThan(2);
  });

  it('gives up after three rounds that add nothing, and says so', async () => {
    // `saturated` reports only that scrolling stopped helping — whether that means
    // "finished" or "gated" is the adapter's call (the stated total includes hidden
    // works, so a shortfall proves nothing).
    setState(profileState(3));
    const snap = await runInjected(100, 10);

    expect(snap.saturated).toBe(true);
    expect(snap.notes).toHaveLength(3);
  });
});

describe('xiaohongshu collector — the header count', () => {
  it('reads a plain integer and refuses an abbreviated one', async () => {
    // The count is the only POSITIVE evidence a dig can use to declare the end,
    // and declaring it wrongly writes `__END__` — permanently blocking a dig that
    // had barely started (rule 10's unrecoverable direction). A big creator's
    // header is abbreviated (「作品 1.2万」), and `/作品\s*(\d+)/` read that as **1**,
    // which `notes.length >= statedTotal` would satisfy on the first page.
    const cases: Array<[string, number | null]> = [
      ['作品 128', 128],
      ['作品 1,024', 1024],
      ['作品 1.2万', null],
      ['作品 3万', null],
      ['作品 1亿', null],
      ['获赞与收藏 5万', null],
    ];

    const seen: string[] = [];
    for (const [body, expected] of cases) {
      document.body.innerText = body;
      setState(profileState(1));
      const snap = await runInjected(10, 0);
      seen.push(`${body}→${String(snap.statedTotal)}`);
      expect(snap.statedTotal, body).toBe(expected);
    }

    // Guard against the loop passing vacuously.
    expect(seen.join(' | ')).toContain('作品 128→128');
  });
});
