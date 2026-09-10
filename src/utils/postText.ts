import type { MediaItem } from '../types';

/**
 * Card text presentation.
 *
 * `Post.title` is not a real title on every platform. The Twitter, Douyin and
 * Xiaohongshu adapters derive it from the body's first line (or from a URL when
 * there is none), so rendering both fields printed the same sentence twice —
 * once bold as the heading and once as the body. The heading is only worth space
 * when it says something the body does not already say.
 */

/** True when the body already opens with the title, so the heading is redundant. */
export function titleRepeatsContent(title: string | undefined, content: string | undefined): boolean {
  const heading = (title || '').trim();
  if (!heading) return false;
  const body = (content || '').trim();
  if (!body) return false;

  if (heading === body) return true;

  // Douyin takes the first line verbatim and RSS often prefixes the title to the
  // body, so compare after folding whitespace and stripping the trailing
  // ellipsis some feeds append.
  const fold = (text: string) => text.replace(/\s+/g, ' ').replace(/…+$|\.\.\.$/, '').trim();
  const foldedHeading = fold(heading);
  return foldedHeading.length > 0 && fold(body).startsWith(foldedHeading);
}

/**
 * Whether the card heading should be rendered.
 *
 * Kept as a named rule rather than an inline condition because it is the single
 * fix for the duplication seen on three platforms at once.
 */
export function shouldShowTitle(post: { title?: string; content?: string }): boolean {
  if (!post.title || !post.title.trim()) return false;
  return !titleRepeatsContent(post.title, post.content);
}

/**
 * Whether a body should be shown in full rather than clamped.
 *
 * RSS items are articles; the four-line clamp reduced them to a teaser with the
 * rest unreachable (the card has no click-to-read view). Every other platform's
 * body is a caption, where the clamp is what keeps the masonry feed scannable.
 */
export function showsFullBody(platform: string): boolean {
  return platform === 'rss';
}

/**
 * Media that needs a standalone block, given the post's body representation.
 *
 * When the body is a structured article (`contentHtml`), its images are rendered
 * inline where the author put them, so listing them again below is duplication —
 * measured on a real newsletter feed, one article carried 23 images and the card
 * showed them as a "+17" gallery under the text. Non-image enclosures (podcast
 * audio, video) have no inline representation and are always kept.
 *
 * Without structure this returns the list unchanged, which is what a photo post
 * (Xiaohongshu, Pixiv, Weibo nine-grid) needs: there the images *are* the post.
 */
export function standaloneMedia(post: {
  contentHtml?: string;
  mediaList?: MediaItem[];
}): MediaItem[] {
  const list = post.mediaList || [];
  if (!post.contentHtml) return list;
  return list.filter((item) => item.type !== 'image');
}
