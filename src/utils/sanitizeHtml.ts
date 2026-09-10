/**
 * Sanitizer for article HTML taken from a feed.
 *
 * A feed item's `<content:encoded>` is third-party input, and the reader renders
 * it with `v-html` — so whatever survives this function reaches the DOM of an
 * extension page. The policy is an allowlist of elements and attributes plus a
 * URL-scheme check:
 *
 *  - Elements outside the allowlist are **unwrapped**: their children are kept,
 *    so a `<section>` around a paragraph does not swallow the paragraph.
 *  - Elements that can execute, restyle or re-navigate are **dropped with their
 *    whole subtree**. Dropping the subtree matters for `<style>` and `<script>`,
 *    whose *text* is code and must not leak into the article as prose.
 *  - Output is a serialization of nodes this function created, never a rewrite of
 *    the input's markup. Pattern-based HTML rewriting is a well-known way to end
 *    up with a bypass; building fresh nodes means an attribute cannot survive by
 *    being spelled unusually (mixed case, stray characters, duplicate quotes).
 *
 * Not a general-purpose sanitizer — it knows exactly one input shape (a feed
 * item's article body) and is deliberately closed about everything else.
 */

/**
 * Elements kept as-is. Grouped by what they are for, because the list is the
 * policy and should be readable as one.
 *
 * `<picture>` and `<source>` are deliberately absent: unwrapping a `<picture>`
 * leaves the `<img>` inside it, which is the element that actually carries a
 * source this allowlist can validate.
 */
const ALLOWED_ELEMENTS = new Set([
  // Text containers
  'p', 'div', 'span', 'br', 'hr', 'wbr',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Inline semantics
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small',
  'sub', 'sup', 'abbr', 'cite', 'q', 'time', 'code', 'kbd', 'samp',
  // Blocks
  'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'figure', 'figcaption',
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // Media and links. `src` and `href` are handled explicitly in `buildElement`,
  // never copied through `applyAttributes` — a URL is the one attribute whose
  // value decides whether the page can be attacked.
  'a', 'img',
]);

/**
 * Elements removed together with everything inside them.
 *
 * `svg`/`math` are dropped rather than unwrapped because their contents are a
 * different namespace. Not because the tags themselves are dangerous, but
 * because `tagName` is uppercased identically for both namespaces: unwrapping
 * would let `<a>` inside them be rebuilt as an HTML anchor carrying an
 * `xlink:href` that this allowlist never inspects.
 *
 * `col`/`colgroup` stay in the allowlist (they are inert layout elements) while
 * `form`/`input`/`button` do not: a feed has no business presenting controls.
 */
const DROPPED_ELEMENTS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'noscript', 'template', 'svg', 'math', 'canvas', 'map', 'area',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'label',
  'link', 'meta', 'base', 'head', 'title', 'body', 'html',
  'video', 'audio', 'track',
]);

/**
 * Attributes copied through, keyed by the element that may carry them. `src` and
 * `href` are absent on purpose — see `buildElement`.
 *
 * `class`, `id` and every `on*` handler are absent too: the reader supplies its
 * own typography, and a feed's inline style could otherwise hide content or
 * break the surrounding layout.
 */
const ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  '*': ['title'],
  ol: ['start'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  time: ['datetime'],
  col: ['span'],
  colgroup: ['span'],
};

/** Attributes whose value must be a small integer to be meaningful. */
const NUMERIC_ATTRIBUTES = new Set(['colspan', 'rowspan', 'span', 'start']);

/**
 * Rough per-element cost against the size budget. Only has to be in the right
 * ballpark: the budget exists to stop a pathological feed bloating a database
 * row, not to be an exact character count.
 */
const ELEMENT_COST = 24;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Strip every character a URL parser tolerates but that can hide a scheme.
 *
 * `java\nscript:alert(1)` and `java\tscript:` are canonical ways to slip past a
 * naive `startsWith('javascript:')` test, and a leading `\u0000` or space can do
 * the same. Done with character codes rather than a regex so the intent (any
 * code point at or below U+0020, plus DEL) is explicit — a `no-control-regex`
 * suppression would have hidden it.
 */
function stripUrlNoise(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * Resolve a URL and return it only if its scheme is one we will load.
 *
 * Relative references are resolved against the article's own URL, so `/img.png`
 * in a feed becomes a real request to the feed's host instead of resolving
 * against `chrome-extension://` and 404ing.
 *
 * The result is parsed and tested on its protocol, never on a prefix of the raw
 * text.
 */
function safeUrl(
  raw: string | null,
  baseUrl: string | undefined,
  allowDataImage: boolean,
): string | null {
  if (!raw) return null;
  const value = stripUrlNoise(raw.trim());
  if (!value) return null;

  if (allowDataImage && /^data:image\//i.test(value)) return value;

  let parsed: URL;
  try {
    parsed = new URL(value, baseUrl);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
}

/** Copy the attributes `tag` is allowed to carry. URLs are not among them. */
function applyAttributes(source: Element, target: Element, tag: string): void {
  const allowed = new Set([...(ALLOWED_ATTRIBUTES['*'] ?? []), ...(ALLOWED_ATTRIBUTES[tag] ?? [])]);
  for (const attr of Array.from(source.attributes)) {
    const name = attr.name.toLowerCase();
    if (!allowed.has(name)) continue;
    const value = attr.value;
    if (value.length > 2048) continue;
    if (NUMERIC_ATTRIBUTES.has(name) && !/^\d{1,3}$/.test(value.trim())) continue;
    target.setAttribute(name, value);
  }
}

/** Build one allowed element, or return `null` when it cannot be represented safely. */
function buildElement(source: Element, tag: string, baseUrl: string | undefined): Element | null {
  if (tag === 'img') {
    const src = safeUrl(source.getAttribute('src'), baseUrl, true);
    // An image with no loadable source is noise: drop it rather than emit a
    // broken-image box.
    if (!src) return null;
    const img = document.createElement('img');
    img.setAttribute('src', src);
    const alt = source.getAttribute('alt');
    if (alt) img.setAttribute('alt', alt.slice(0, 300));
    // Matches every other image in the app, and keeps a 20-image article from
    // firing all of its requests the moment the reader opens.
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.setAttribute('loading', 'lazy');
    return img;
  }

  if (tag === 'a') {
    const href = safeUrl(source.getAttribute('href'), baseUrl, false);
    // A link we cannot resolve is unwrapped by the caller, which keeps its text.
    if (!href) return null;
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    // The reader is an extension page: a feed link must not navigate it away.
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
    applyAttributes(source, anchor, tag);
    return anchor;
  }

  const built = document.createElement(tag);
  applyAttributes(source, built, tag);
  return built;
}

/**
 * Sanitize `source` — an already-parsed container whose children are the article
 * — into an HTML string, bounded by `maxChars`.
 *
 * `baseUrl` should be the feed item's own link, used to resolve relative URLs.
 */
export function sanitizeArticleHtml(
  source: Element,
  baseUrl?: string,
  maxChars = 60000,
): string {
  const sink = document.createElement('div');
  const budget = { left: maxChars };

  const walk = (from: Node, to: Node): void => {
    for (const child of Array.from(from.childNodes)) {
      if (budget.left <= 0) return;

      if (child.nodeType === TEXT_NODE) {
        const text = child.textContent ?? '';
        if (!text) continue;
        budget.left -= text.length;
        to.appendChild(document.createTextNode(text));
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;

      const element = child as Element;
      const tag = element.tagName.toLowerCase();

      if (DROPPED_ELEMENTS.has(tag)) continue;

      if (!ALLOWED_ELEMENTS.has(tag)) {
        // Unwrap: keep the text, lose the wrapper.
        walk(element, to);
        continue;
      }

      const built = buildElement(element, tag, baseUrl);
      if (!built) {
        walk(element, to);
        continue;
      }
      budget.left -= ELEMENT_COST;
      to.appendChild(built);
      walk(element, built);
    }
  };

  walk(source, sink);
  return sink.innerHTML;
}

/**
 * Whether sanitized output actually carries structure.
 *
 * A feed whose body is plain text produces no tags, and storing that as HTML
 * would lose the feed's own line breaks — the reader's `whitespace-pre-wrap`
 * path preserves them. Callers use this to decide which path to store.
 */
export function hasArticleMarkup(html: string): boolean {
  return /<[a-z][a-z0-9]*[\s/>]/i.test(html);
}
