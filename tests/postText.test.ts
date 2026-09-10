import { describe, expect, it } from 'vitest';
import { shouldShowTitle, showsFullBody, titleRepeatsContent } from '../src/utils/postText';

/**
 * Card text presentation.
 *
 * Observed in the 2026-09 feed: Douyin, Twitter and Xiaohongshu cards each
 * printed the same sentence twice — bold as the heading, again as the body.
 * `Post.title` is body-derived on those platforms, so rendering both fields
 * unconditionally duplicated every caption.
 *
 * The heading must survive where it carries information the body does not (a
 * video title, an RSS item title) and be dropped where it just echoes the body.
 */

describe('titleRepeatsContent', () => {
  it('detects an exact echo', () => {
    expect(titleRepeatsContent('露露卡', '露露卡')).toBe(true);
    expect(titleRepeatsContent('我再也不嘴硬了 我只是想给你一个拥抱', '我再也不嘴硬了 我只是想给你一个拥抱')).toBe(true);
  });

  it('detects a body that starts with the title (first line reused as heading)', () => {
    // Twitter/Douyin derive the title from the first line, then keep the whole
    // text as the body.
    expect(titleRepeatsContent('强强又击击', '强强又击击\n#ウマ娘 #ヴィブロス')).toBe(true);
  });

  it('ignores whitespace and a trailing ellipsis', () => {
    expect(titleRepeatsContent('AI 早报   2026 09 08', 'AI 早报 2026 09 08 视频版：…')).toBe(true);
  });

  it('keeps a heading that says something the body does not', () => {
    expect(titleRepeatsContent('2026-09-08', 'AI 早报视频版：哔哩哔哩 | YouTube')).toBe(false);
    expect(titleRepeatsContent('【MMD】测试', '本视频使用了新的渲染管线')).toBe(false);
  });

  it('treats a missing title or body as "no duplication"', () => {
    expect(titleRepeatsContent('', 'body')).toBe(false);
    expect(titleRepeatsContent(undefined, 'body')).toBe(false);
    expect(titleRepeatsContent('title', '')).toBe(false);
    expect(titleRepeatsContent('title', undefined)).toBe(false);
  });
});

describe('shouldShowTitle', () => {
  it('hides the heading when it echoes the body', () => {
    expect(shouldShowTitle({ title: '露露卡', content: '露露卡' })).toBe(false);
  });

  it('shows the heading for a real title', () => {
    expect(shouldShowTitle({ title: '2026-09-08', content: 'AI 早报…' })).toBe(true);
  });

  it('shows nothing for an empty title', () => {
    expect(shouldShowTitle({ title: '   ', content: 'body' })).toBe(false);
    expect(shouldShowTitle({ content: 'body' })).toBe(false);
  });

  it('handles a post with no body at all', () => {
    // A media-only post keeps whatever heading it has.
    expect(shouldShowTitle({ title: '无标题动态' })).toBe(true);
  });
});

describe('showsFullBody', () => {
  it('shows RSS bodies in full', () => {
    // RSS items are articles; the 4-line clamp left them as unreachable teasers
    // once the click-to-read view was removed.
    expect(showsFullBody('rss')).toBe(true);
  });

  it('keeps the clamp for caption platforms', () => {
    for (const platform of ['twitter', 'bilibili', 'douyin', 'weibo', 'xiaohongshu', 'youtube', 'pixiv']) {
      expect(showsFullBody(platform)).toBe(false);
    }
  });
});
