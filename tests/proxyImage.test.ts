import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleProxyImage } from '../src/infrastructure/chrome/messages/proxyImage';

/**
 * The image proxy's host policy.
 *
 * This handler used to refuse every host outside `PLATFORM_HOSTS`, which made
 * every RSS article image unreadable: a feed may host its images anywhere
 * (measured: `assets.juya.uk`, 23 images in one article) and the proxy is the
 * only path that can load a CDN that blocks hotlinking or sends no CORS header.
 *
 * Removing that check is only safe because the rule in AGENTS.md rule 3 is about
 * *credentials*, not reachability — and that is exactly what these tests pin: any
 * http(s) host may be fetched, and only a platform host may carry the session.
 */

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  credentials: string | undefined;
}

let calls: FetchCall[];

/** What every candidate URL answers with, until a test overrides it. */
let served: { contentType: string; bytes: Uint8Array } = {
  contentType: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

/** A `Response`-ish object that streams, like the real one does. */
function responseWith(bytes: Uint8Array, contentType: string): unknown {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    arrayBuffer: async () => bytes.buffer,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}

function installFetch(): void {
  calls = [];
  served = { contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      credentials: init.credentials,
    });
    return responseWith(served.bytes, served.contentType);
  });
}

/** Run the handler and resolve with what it responded. */
function run(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    handleProxyImage({ type: 'PROXY_IMAGE', url }, (response) => {
      resolve((response ?? {}) as Record<string, unknown>);
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleProxyImage — arbitrary hosts', () => {
  it('proxies an image from a host that is not a platform', async () => {
    // The RSS case: a feed's own image host, which the extension has no
    // host permission for and whose CDN may refuse a hotlinked request.
    installFetch();

    const res = await run('https://assets.juya.uk/imagehub/cover.png');

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://assets.juya.uk/imagehub/cover.png');
  });

  it('sends no credentials and no invented Referer to an unknown host', async () => {
    // Membership in the allowlist buys credentials; an unknown host gets none.
    // Sending another platform's Referer would be worse than sending none.
    installFetch();

    await run('https://assets.juya.uk/imagehub/cover.png');

    expect(calls[0].credentials).toBe('omit');
    expect(calls[0].headers.Referer).toBeUndefined();
  });

  it('still rejects a non-http(s) scheme', async () => {
    installFetch();

    const res = await run('file:///etc/passwd');

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('still rejects a URL carrying embedded credentials', async () => {
    // `https://user:pass@host/` is a way to make a fetched URL look like one
    // host while being another; parseFetchableUrl refuses it outright.
    installFetch();

    const res = await run('https://user:pass@evil.example/x.png');

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-URL without fetching', async () => {
    installFetch();

    const res = await run('not a url');

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('handleProxyImage — platform hosts keep their session', () => {
  it('sends the platform Referer for a known media CDN', async () => {
    installFetch();

    await run('https://i0.hdslb.com/bfs/face/x.png');

    expect(calls[0].headers.Referer).toBe('https://www.bilibili.com/');
    expect(calls[0].credentials).toBe('omit');
  });

  it('sends cookies only for the platform that needs them', async () => {
    // Xiaohongshu media 403s without the session; no other host gets it.
    installFetch();

    await run('https://sns-webpic-qc.xhscdn.com/abc123');

    expect(calls[0].credentials).toBe('include');
  });

  it('does not send cookies to a non-platform host that merely looks related', async () => {
    installFetch();

    await run('https://xhscdn.com.attacker.tld/x.png');

    expect(calls[0].credentials).toBe('omit');
  });
});

/**
 * Resource ceilings.
 *
 * The proxy had none: it read the body with `arrayBuffer()`, copied it into a
 * `Uint8Array`, built a JS binary string, base64-encoded that (~1.37×), and sent
 * it across the runtime message channel — five live representations of one
 * response, each larger than the last. `BG_FETCH` got a ceiling for this reason;
 * this path was missed, and its host is the less trusted of the two (any http(s)
 * host by design, AGENTS rule 3).
 */
describe('handleProxyImage — resource ceilings', () => {
  it('refuses a body that is not an image', async () => {
    // Measured on the same session as the transport-truncation bug: an image URL
    // answered `text/html` (a site root), and the proxy base64'd the whole page
    // into a data URL that could never render as an `<img>`.
    installFetch();
    served = { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode('<!doctype html><html>') };

    const res = await run('https://example.com/not-really-an-image');

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('不是图片');
  });

  it('accepts any image/* subtype, including svg', async () => {
    // The request already asks for `image/svg+xml`, and an `<img>` data URL has
    // no scripting context, so the usual SVG hazard does not apply here.
    for (const type of ['image/webp', 'image/avif', 'image/svg+xml']) {
      installFetch();
      served = { contentType: type, bytes: new Uint8Array([1, 2, 3]) };
      const res = await run('https://example.com/pic');
      expect(res.ok, type).toBe(true);
    }
  });

  it('refuses an oversized body instead of encoding it', async () => {
    installFetch();
    served = { contentType: 'image/png', bytes: new Uint8Array(9 * 1024 * 1024) };

    const res = await run('https://example.com/huge.png');

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('上限');
  });

  it('still serves a large-but-legal image', async () => {
    // The complement: a ceiling that rejects ordinary images is worse than none.
    installFetch();
    served = { contentType: 'image/png', bytes: new Uint8Array(2 * 1024 * 1024) };

    const res = await run('https://example.com/big-but-fine.png');

    expect(res.ok).toBe(true);
    expect(String(res.dataUrl)).toMatch(/^data:image\/png;base64,/);
  });
});
