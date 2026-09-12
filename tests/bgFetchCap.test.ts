import { describe, expect, it, vi } from 'vitest';
import { performBgFetch } from '../src/infrastructure/chrome/messages/bgFetch';

/**
 * Response-size ceiling (audit P2-5 / P2-18).
 *
 * The RSS host is user-supplied by design (AGENTS rule 3), so `bgFetch` reads
 * bytes from a host we do not control. The downstream caps (20000/60000 chars)
 * only run after the whole body has been read and pushed across the message
 * boundary, so they bound what we KEEP, not what we PAY — a multi-megabyte feed
 * or a `data:` URI still costs the worker and the message channel everything.
 *
 * These tests pin the boundary: the cap applies at `bgFetch`, so the body never
 * arrives whole.
 */

/** A Response whose stream yields `total` chunks of `chunkSize` characters. */
function streamingResponse(chunkSize: number, total: number, status = 200): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(new TextEncoder().encode('x'.repeat(chunkSize)));
    },
  });
  return new Response(stream, { status });
}

describe('bgFetch response cap', () => {
  it('truncates a body larger than the ceiling', async () => {
    // 400 chunks × 1000 chars = 400 000 chars, above the 250 000 ceiling.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingResponse(1000, 400));

    const result = await performBgFetch('https://feeds.example.com/huge.xml');

    expect(result.ok).toBe(true);
    expect(result.data.length).toBe(250_000);
    fetchSpy.mockRestore();
  });

  it('passes a normal body through untouched', async () => {
    const body = '<rss><channel><item><title>hi</title></item></channel></rss>';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));

    const result = await performBgFetch('https://feeds.example.com/small.xml');

    expect(result.ok).toBe(true);
    expect(result.data).toBe(body);
    fetchSpy.mockRestore();
  });

  it('stops reading once the ceiling is reached instead of draining the stream', async () => {
    // The cost this guards against is READING the body. A stream that yields 1000
    // chunks of 1000 chars (1 000 000 total) must not be drained to serve a
    // 250 000-char ceiling — so count the pulls rather than trusting the length.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 1000) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1000)));
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));

    const result = await performBgFetch('https://feeds.example.com/unbounded.xml');

    expect(result.data.length).toBe(250_000);
    // 250 chunks cover the ceiling; anything near 1000 means the stream was drained.
    expect(pulled).toBeLessThan(300);
    fetchSpy.mockRestore();
  });

  it('caps a data: URI body too (no network involved)', async () => {
    const big = `data:text/plain,${'y'.repeat(400_000)}`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('data:')) {
        return new Response(url.slice(url.indexOf(',') + 1), { status: 200 });
      }
      throw new Error('unexpected');
    });

    const result = await performBgFetch(big);
    // A data: URI is rejected by the URL policy (only http/https), so either it
    // never fetches or it is capped — both are safe; assert no giant body.
    expect(result.data.length).toBeLessThanOrEqual(250_000);
    fetchSpy.mockRestore();
  });
});

/**
 * The response body's SHAPE, logged so a failure is diagnosable from the panel.
 *
 * Three failures in one real session were each undiagnosable even though the
 * answer was in the response: an RSS feed serving `text/html` (Cloudflare-cached
 * site root) where XML was expected, a YouTube handle that resolved to nothing,
 * and a Xiaohongshu profile with no SSR payload. In every case the log said only
 * `HTTP 200`, and `Content-Type` plus the leading bytes would have named it.
 *
 * These assert the LOGGED text, because the value of this feature is what the
 * user can read — not that some helper returns a string.
 */
describe('bgFetch body-shape diagnostics', () => {
  async function loggedDetailFor(contentType: string, body: string): Promise<string> {
    const { devLog } = await import('../src/utils/devLog');
    await devLog.clear();
    // The success path logs at `debug`, which is dropped unless the panel's
    // verbose switch is on — that is the deliberate design (rule 11: debug lines
    // are kept only while verbose is on). So a test asserting on the diagnostics
    // has to switch it on, exactly as a user diagnosing this would.
    await devLog.setVerbose(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    );
    await performBgFetch('https://feeds.example.com/f.xml');
    fetchSpy.mockRestore();
    // `record` is fire-and-forget by design (logging must never block the
    // caller), so the read has to wait for the queued append to land.
    await devLog.flush();
    const entries = await devLog.read();
    await devLog.setVerbose(false);
    return entries.map((e) => e.detail || '').join('\n');
  }

  it('names HTML when an XML endpoint serves the site root', async () => {
    // The exact shape the user's feed returned on 2026-09-13.
    const detail = await loggedDetailFor('text/html; charset=utf-8', '<!doctype html><html>…</html>');
    expect(detail).toContain('text/html');
    expect(detail).toContain('HTML');
  });

  it('names XML and JSON, so the right parser can be chosen next time', async () => {
    expect(await loggedDetailFor('application/rss+xml', '<?xml version="1.0"?><rss/>')).toContain('XML');
    expect(await loggedDetailFor('application/json', '{"code":0}')).toContain('JSON');
  });

  it('says so when the body is empty, rather than reporting only the status', async () => {
    // «HTTP 200» over an empty body is precisely the case that reads as success.
    expect(await loggedDetailFor('text/html', '')).toContain('空响应');
  });

  it('never logs the body itself', async () => {
    // The panel is screenshotted into bug reports (rule 11): a response can carry
    // a session token or the user's own content, so only shape may be recorded.
    const secret = 'SENTINEL_TOKEN_abcdef0123456789';
    const detail = await loggedDetailFor('application/json', `{"token":"${secret}"}`);
    expect(detail).not.toContain(secret);
  });
});
