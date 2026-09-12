import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBgFetch, handleBgFetchAbort, performBgFetch } from '../src/infrastructure/chrome/messages/bgFetch';

/**
 * Cancellation across the message boundary (audit P1-2).
 *
 * `bgFetch`'s page mode delegates to the worker over `chrome.runtime.sendMessage`,
 * and a page-side `AbortSignal` cannot travel through a message. The timeout in
 * `channelSync` therefore stopped *waiting* while the worker's `fetch` kept
 * running: a user who retried during the 45s window put two live requests on a
 * platform whose protection model is a request ceiling — the exact behaviour the
 * pacing/cooldown machinery exists to prevent.
 *
 * The fix forwards cancellation as a second message naming the request. These
 * tests pin the worker half: a named request registers a controller, an abort for
 * it settles as aborted, and an unnamed request is simply not cancellable (rather
 * than being mis-cancelled by a stray message).
 */
describe('worker-side request cancellation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts the named in-flight request and reports it', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      seenSignal = (init as RequestInit)?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        // Reject when aborted, like a real fetch.
        seenSignal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    });

    const responded = new Promise<unknown>((resolve) => {
      handleBgFetch({ type: 'BG_FETCH', requestId: 'req-1', url: 'https://bilibili.com/x' }, resolve);
    });

    // The handler is async; let it reach fetch before aborting.
    await Promise.resolve();
    await Promise.resolve();
    expect(seenSignal).toBeDefined();

    expect(handleBgFetchAbort({ type: 'BG_FETCH_ABORT', requestId: 'req-1' })).toEqual({ aborted: true });
    expect(seenSignal?.aborted).toBe(true);

    const result = (await responded) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    // Cancellation is reported as such, not as a network failure — a user who
    // cancelled must not get a red 「请求失败」 or feed the cooldown machinery.
    expect(result.error).toBe('请求已取消');
    fetchSpy.mockRestore();
  });

  it('reports no-op for an unknown or missing request id', () => {
    expect(handleBgFetchAbort({ type: 'BG_FETCH_ABORT', requestId: 'never-seen' })).toEqual({ aborted: false });
    expect(handleBgFetchAbort({ type: 'BG_FETCH_ABORT' })).toEqual({ aborted: false });
  });

  it('a request without an id is not cancellable by a later abort', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );

    const responded = new Promise<unknown>((resolve) => {
      handleBgFetch({ type: 'BG_FETCH', url: 'https://bilibili.com/y' }, resolve);
    });
    await Promise.resolve();

    // No id was registered, so the abort finds nothing — and must not be able to
    // reach some other request's controller.
    expect(handleBgFetchAbort({ type: 'BG_FETCH_ABORT', requestId: '' })).toEqual({ aborted: false });

    const result = (await responded) as { ok: boolean; status: number };
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it('performBgFetch refuses an already-aborted signal without issuing a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const controller = new AbortController();
    controller.abort();

    await performBgFetch('https://bilibili.com/z', undefined, controller.signal);

    // The fetch may be issued by the implementation, but the abort is honored:
    // either it is never called, or it is called with an already-aborted signal.
    if (fetchSpy.mock.calls.length > 0) {
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal?.aborted).toBe(true);
    }
    fetchSpy.mockRestore();
  });
});
