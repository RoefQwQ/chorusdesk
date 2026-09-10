import { describe, expect, it } from 'vitest';
import { normalizeRssContent } from '../src/adapters/rss';

/**
 * RSS body storage.
 *
 * The adapter capped `content` at 350 characters. Once the click-to-read card
 * view was removed that teaser became the entire post — articles stopped
 * mid-sentence with no way to read the rest in the app. RSS is the one platform
 * whose body is prose meant to be read in place, so the full text is stored.
 */

describe('normalizeRssContent', () => {
  it('keeps an article well past the old 350-character ceiling', () => {
    const article = 'AI 早报正文。'.repeat(200); // ~1400 chars
    const stored = normalizeRssContent(article);

    expect(stored).toHaveLength(article.length);
    expect(stored).toContain('AI 早报正文。');
    // No 350-char cut and no trailing ellipsis from the old implementation.
    expect(stored.endsWith('...')).toBe(false);
    expect(stored.slice(0, 400)).toBe(article.slice(0, 400));
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRssContent('  正文  ')).toBe('正文');
  });

  it('caps a pathological body and marks the cut', () => {
    // A feed that puts a whole book in one <description> must not bloat storage.
    const huge = 'x'.repeat(10_000);
    const stored = normalizeRssContent(huge);

    expect(stored.length).toBeLessThanOrEqual(4001);
    expect(stored.endsWith('…')).toBe(true);
  });

  it('does not add an ellipsis to a body exactly at the ceiling', () => {
    const exact = 'y'.repeat(4000);
    expect(normalizeRssContent(exact)).toBe(exact);
  });

  it('handles an empty body', () => {
    expect(normalizeRssContent('')).toBe('');
    expect(normalizeRssContent('   ')).toBe('');
  });
});
