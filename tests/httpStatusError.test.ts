import { describe, expect, it, vi } from 'vitest';
import { HttpStatusError, fetchError, httpStatusError, toFetchError } from '../src/adapters/types';

/**
 * `code` is policy, not a label: `rate_limit` starts a persisted platform
 * cool-down (`batchSync` → `noteRateLimit`) and `not_found` makes a history dig
 * write `__END__`, which permanently stops that channel from digging. So a
 * misclassification is a behavioural bug, not a wording preference.
 *
 * Before the shared classifier existed the adapters disagreed, measured:
 *   weibo:        403 → auth, everything else (including 429) → network
 *   xiaohongshu:  every status → network
 *   pixiv/fantia: status thrown into a message, caught as network
 * A platform answering `429 Too Many Requests` was therefore reported as a
 * connection problem and **never entered a cool-down** — the one response rule 19
 * exists to handle.
 */

describe('httpStatusError', () => {
  it('maps 429 to rate_limit, which is what starts a cool-down', () => {
    // The behavioural case: this is the only way a platform's "slow down" reaches
    // `noteRateLimit`. Calling it `network` silently skips the cool-down.
    expect(httpStatusError(429, '微博').code).toBe('rate_limit');
  });

  it('maps 401 and 403 to auth — the user can act on that', () => {
    expect(httpStatusError(401, 'Pixiv').code).toBe('auth');
    expect(httpStatusError(403, '微博').code).toBe('auth');
  });

  it('maps 404 and 410 to not_found, and 5xx to network', () => {
    expect(httpStatusError(404, 'Fantia').code).toBe('not_found');
    expect(httpStatusError(410, 'Fantia').code).toBe('not_found');
    for (const status of [500, 502, 503, 504]) {
      expect(httpStatusError(status, '小红书').code).toBe('network');
    }
  });

  it('maps other 4xx to network without pretending it is a session problem', () => {
    // 400/418/451 are the server refusing THIS request for its own reasons;
    // telling the user to log in would be wrong advice.
    for (const status of [400, 405, 418, 451]) {
      expect(httpStatusError(status, 'RSS').code).toBe('network');
    }
  });

  it('always names the platform and the status in the message', () => {
    const err = httpStatusError(503, '微博');
    expect(err.message).toContain('微博');
    expect(err.message).toContain('503');
  });

  it('never classifies an unknown status as a success-shaped code', () => {
    // A code that reads as "nothing here" must come only from a status that means
    // it — a stray value must not park a channel at the end of history.
    for (const status of [0, 1, 199, 200, 999]) {
      expect(httpStatusError(status, 'X').code).not.toBe('not_found');
    }
  });
});

describe('toFetchError resolves a thrown HTTP status', () => {
  it('keeps the status class while preserving the adapter’s message', () => {
    const err = toFetchError(
      new HttpStatusError(429, 'Pixiv 接口响应异常: HTTP 429'),
      'Pixiv',
      'fallback',
    );
    expect(err.code).toBe('rate_limit');
    // The adapter's own wording is what explains this endpoint.
    expect(err.message).toBe('Pixiv 接口响应异常: HTTP 429');
  });

  it('treats a plain throw as parse — the response did not match the parser', () => {
    // A missing or renamed field is a schema change, not a network fault; the
    // queue entry for this was "JSON/XML parse error 可能归类为 network".
    expect(toFetchError(new Error('Fantia API 响应缺少 recent_posts 字段'), 'Fantia', 'fb').code).toBe('parse');
    expect(toFetchError(new Error('Unexpected token < in JSON'), 'Pixiv', 'fb').code).toBe('parse');
  });

  it('falls back to the adapter’s message when the thrown value carries none', () => {
    expect(toFetchError('not an error', 'Fantia', 'Fantia 更新抓取失败').message).toBe(
      'Fantia 更新抓取失败',
    );
    expect(toFetchError(undefined, 'Fantia', 'Fantia 更新抓取失败').message).toBe(
      'Fantia 更新抓取失败',
    );
  });

  it('does not confuse a message that merely mentions a status with a status error', () => {
    // Only the marker class carries a status; a string that says "HTTP 429" is a
    // parse failure and must not start a cool-down.
    const plain = toFetchError(new Error('HTTP 429 in the body'), 'X', 'fb');
    expect(plain.code).toBe('parse');
  });
});

describe('fetchError stays the single constructor', () => {
  it('passes the code through unchanged', () => {
    expect(fetchError('storage', 'x')).toEqual({ code: 'storage', message: 'x' });
  });
});

/**
 * The wiring, not just the mapper.
 *
 * A correct classifier that an adapter never calls changes nothing, and the
 * divergence being fixed was exactly that: each adapter did its own thing. These
 * drive the real adapters with a `bgFetch` answering 429 — the one status whose
 * classification has a behavioural consequence (a persisted platform cool-down) —
 * and require every HTTP-fetching adapter to agree.
 */
describe('every HTTP-fetching adapter routes its status through the classifier', () => {
  const channel = (platform: string, accountId: string) => ({
    id: `${platform}:${accountId}`,
    platform,
    accountId,
    creatorId: 'c1',
    displayName: 'T',
    status: 'idle',
  });

  async function fetchWith(platform: string, modulePath: string, method: 'fetchLatest' | 'fetchAjaxFallback' = 'fetchLatest') {
    vi.resetModules();
    vi.doMock('../src/infrastructure/chrome/http', () => ({
      bgFetch: async () => ({ ok: false, status: 429, data: '', statusText: 'Too Many Requests' }),
    }));
    const mod = (await import(modulePath)) as Record<string, { [k: string]: (...a: unknown[]) => Promise<{ error?: { code: string } }> }>;
    const adapter = Object.values(mod).find((v) => v && typeof v === 'object' && 'platform' in v) as unknown as {
      platform: string;
      fetchLatest: (c: unknown, limit?: number, o?: unknown) => Promise<{ error?: { code: string } }>;
      fetchAjaxFallback?: (c: unknown, limit: number, page: number) => Promise<{ error?: { code: string } }>;
    };
    const ch = channel(platform, 'u1');
    return method === 'fetchLatest'
      ? adapter.fetchLatest(ch, 10)
      : adapter.fetchAjaxFallback!(ch, 10, 1);
  }

  it('xiaohongshu reports a 429 as rate_limit, so the platform cools down', async () => {
    expect((await fetchWith('xiaohongshu', '../src/adapters/xiaohongshu')).error?.code).toBe('rate_limit');
  });

  it('weibo reports a 429 as rate_limit', async () => {
    expect((await fetchWith('weibo', '../src/adapters/weibo', 'fetchAjaxFallback')).error?.code).toBe('rate_limit');
  });

  it('pixiv reports a 429 as rate_limit', async () => {
    expect((await fetchWith('pixiv', '../src/adapters/pixiv')).error?.code).toBe('rate_limit');
  });

  it('fantia reports a 429 as rate_limit', async () => {
    expect((await fetchWith('fantia', '../src/adapters/fantia')).error?.code).toBe('rate_limit');
  });
});
