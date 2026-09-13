import { describe, expect, it } from 'vitest';
import { extractInitialState, hasInitialStateMarker } from '../src/adapters/xiaohongshu/profileState';

/**
 * The SSR state object is **JavaScript**, not JSON, and the parser must survive
 * every non-JSON token the pages actually contain.
 *
 * The user's own Developer Log is the evidence, from the note-DETAIL page — the
 * one `enrichImageNoteMedia` fetches:
 *
 *     初始化状态解析失败
 *     Unexpected token 'e', ..."tailMap":new Map([])"... is not valid JSON
 *
 * The previous cleaner replaced bare `undefined` only, so `new Map([])` made the
 * whole parse throw. The consequence was user-visible and quiet: the detail page
 * yielded no state, so no `imageList`, so a multi-image note kept its single
 * cover — "部分图片无法获取" with no error the user could act on.
 *
 * The profile page happened to work (its state has only `undefined`), which is
 * why this shipped: the failing shape lives on a *different* page than the one
 * that had been looked at.
 */

/** Wrap a state literal the way the real page does. */
function page(literal: string): string {
  return `<!doctype html><html><body><script>window.__INITIAL_STATE__=${literal}</script></body></html>`;
}

describe('xiaohongshu — the SSR state parser', () => {
  it('parses the exact shape that failed in production', () => {
    // Verbatim from the log: `tailMap` is a page-internal cache the page writes
    // as a Map, which JSON has no syntax for.
    const state = extractInitialState(
      page('{"note":{"noteDetailMap":{}},"tailMap":new Map([])}'),
    );

    expect(state).not.toBeNull();
    // The field we actually need survives; only the cache becomes null.
    expect(state!.note).toBeDefined();
    expect((state as Record<string, unknown>).tailMap).toBeNull();
  });

  it('keeps the note detail data beside a MobX-style cache', () => {
    // The realistic detail-page shape: the real payload and the cache side by side.
    const state = extractInitialState(
      page(
        '{"note":{"noteDetailMap":{"6a0000000000000025037c00":{"note":'
        + '{"title":"T","imageList":[{"urlDefault":"https://sns-img.xhscdn.com/a.jpg"}]}}}}'
        + ',"tailMap":new Map([["k",1]])}',
      ),
    );

    expect(state).not.toBeNull();
    const note = (
      ((state!.note as Record<string, unknown>).noteDetailMap as Record<string, unknown>)[
        '6a0000000000000025037c00'
      ] as Record<string, unknown>
    ).note as Record<string, unknown>;
    expect(note.title).toBe('T');
    expect(Array.isArray(note.imageList)).toBe(true);
  });

  it('handles every non-JSON literal the pages carry', () => {
    const state = extractInitialState(
      page('{"u":undefined,"n":NaN,"i":Infinity,"ni":-Infinity,"s":new Set([1]),"d":new Date(0)}'),
    );

    expect(state).not.toBeNull();
    for (const key of ['u', 'n', 'i', 'ni', 's', 'd']) {
      expect((state as Record<string, unknown>)[key], key).toBeNull();
    }
  });

  it('does not corrupt a string that merely contains those words', () => {
    // The scanner tracks string literals, so text survives verbatim — a
    // regex-based replace would have rewritten what is inside the quotes.
    const state = extractInitialState(
      page('{"body":"call new Map( here","note":"has undefined inside"}'),
    );

    expect(state!.body).toBe('call new Map( here');
    expect(state!.note).toBe('has undefined inside');
  });

  it('keeps an escaped quote from ending a string early', () => {
    const state = extractInitialState(
      page('{"t":"quote \\" then new Set(x) end","n":NaN}'),
    );

    expect(state!.t).toBe('quote " then new Set(x) end');
    expect((state as Record<string, unknown>).n).toBeNull();
  });

  it('nests a constructor inside another one without truncating it', () => {
    // The balanced scan must not stop at the inner `)`.
    const state = extractInitialState(
      page('{"a":new Map([["k",new Set([1,2])]]),"b":"after","c":new Map([]),"d":1}'),
    );

    expect((state as Record<string, unknown>).a).toBeNull();
    expect(state!.b).toBe('after');
    expect((state as Record<string, unknown>).c).toBeNull();
    expect((state as Record<string, unknown>).d).toBe(1);
  });

  it('still parses a JSON.parse-wrapped state', () => {
    const inner = JSON.stringify({ user: { userId: 'u1' } });
    const state = extractInitialState(
      `<!doctype html><script>window.__INITIAL_STATE__=JSON.parse(${JSON.stringify(inner)})</script>`,
    );

    expect(state).not.toBeNull();
    expect((state!.user as Record<string, unknown>).userId).toBe('u1');
  });

  it('applies the same repair inside a JSON.parse-wrapped state', () => {
    // The wrapped string is itself a JS literal, so it needs the same pass.
    const inner = '{"a":1,"tailMap":new Map([]),"b":2}';
    const state = extractInitialState(
      `<!doctype html><script>window.__INITIAL_STATE__=JSON.parse(${JSON.stringify(inner)})</script>`,
    );

    expect(state).not.toBeNull();
    expect((state as Record<string, unknown>).a).toBe(1);
    expect((state as Record<string, unknown>).tailMap).toBeNull();
  });

  it('reports the marker separately from the parse', () => {
    // The adapter tells the two failures apart with this — a truncated body has
    // the marker but no parseable state.
    expect(hasInitialStateMarker(page('{"a":1}'))).toBe(true);
    expect(hasInitialStateMarker('<html>登录后查看</html>')).toBe(false);
  });
});
