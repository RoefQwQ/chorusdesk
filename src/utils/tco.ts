/**
 * X's `t.co` short links.
 *
 * X appends a shortened URL to a tweet's text for every attached medium and for
 * a quoted tweet, and it does so in a way the author did not write. Two things
 * need to recognise that:
 *
 *  - the adapter, which has the payload's entity list and can therefore tell an
 *    appended link from one the author typed (`entities.urls` is where a typed
 *    link lives, never a media entity);
 *  - the stored-row cleanup, which has only the text — no entity list survives in
 *    the database — and must therefore use a narrower, text-only rule.
 *
 * Lives in `utils` because both the adapter and the DB migration use it; the
 * adapters must not import the db and the db must not import an adapter
 * (AGENTS rule 8).
 */

/** A `t.co` short link, and nothing else. */
const TCO_URL = /^https:\/\/t\.co\/\w+$/;

/** True when `value` is exactly a `t.co` short link. */
export function isTcoUrl(value: unknown): value is string {
  return typeof value === 'string' && TCO_URL.test(value.trim());
}

/**
 * Remove the `t.co` URLs X appended to a tweet's text.
 *
 * The candidates come from the payload's own media/quoted entities, so only
 * links X named as appended are ever removed. An author-typed link lives in
 * `entities.urls` — never in a media entity — so it is absent from the candidate
 * set and survives, which is the whole reason this is driven by entities rather
 * than by pattern-matching the text.
 *
 * X's own clients do the same. That is deliberate: `display_text_range` was
 * believed to exclude the appended link, and it does not, so keying on the range
 * is what let the link through in the first place.
 *
 * Non-`t.co` values are rejected rather than used as search strings: the list
 * comes from untrusted payload JSON, and a malformed entry must not be able to
 * blank out arbitrary text by matching a substring of it.
 */
export function stripAppendedLinks(text: string, appendedUrls: readonly unknown[]): string {
  let out = text;
  for (const raw of appendedUrls) {
    if (!isTcoUrl(raw)) continue;
    const url = raw.trim();
    // Removed occurrence by occurrence rather than with one `replace`, so the
    // pass cannot restart inside text it already rewrote.
    out = out.split(url).join(' ');
  }
  return collapseGaps(out);
}

/**
 * Remove a trailing `t.co` link from a body that has no entity data left.
 *
 * Used only for rows already in the database, where the entity list is gone and
 * an appended link is therefore indistinguishable from a typed one. Hence the
 * narrow shape: only links at the very **end** of the text, and only on a row
 * that has media (the caller enforces the media half) — which is where X puts
 * them. Anything in the middle of a caption is left alone, because a link there
 * is far more likely to be the author's.
 *
 * Returns the text unchanged when there is nothing to remove.
 */
export function stripTrailingTcoLink(text: string): string {
  const parts = text.split(/(\s+)/);
  let end = parts.length;
  let removed = false;

  while (end > 0) {
    const token = parts[end - 1];
    if (token.trim() === '') {
      end--;
      continue;
    }
    if (!isTcoUrl(token)) break;
    removed = true;
    end--;
    // Drop the whitespace the link was separated by, so a link on its own line
    // does not leave a blank one behind.
    while (end > 0 && parts[end - 1].trim() === '') end--;
  }

  return removed ? parts.slice(0, end).join('').trim() : text;
}

/** Collapse the gaps a removed link leaves: doubled spaces and blank lines. */
function collapseGaps(text: string): string {
  return text
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
