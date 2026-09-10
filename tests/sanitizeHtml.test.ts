// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hasArticleMarkup, sanitizeArticleHtml } from '../src/utils/sanitizeHtml';

/**
 * The sanitizer stands between a feed and `v-html` on an extension page.
 *
 * A failure here is not a rendering bug, it is script execution inside a page
 * that holds the user's session cookies — so every case below is an attack, not a
 * formatting preference. The input is third-party by construction: anyone who can
 * get a feed URL into the app controls it.
 */

function sanitize(html: string, base = 'https://feed.example/post/1'): string {
  const container = document.createElement('div');
  container.innerHTML = html;
  return sanitizeArticleHtml(container, base);
}

function parse(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = sanitize(html);
  return container;
}

describe('sanitizeArticleHtml — scripts and handlers', () => {
  it('drops a script element with its code', () => {
    const out = sanitize('<p>hi</p><script>alert(1)</script>');

    expect(out).not.toContain('script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('hi');
  });

  it('drops a style element rather than leaving its CSS as text', () => {
    // Unwrapping instead of dropping would print the rules into the article.
    const out = sanitize('<style>body{display:none}</style><p>hi</p>');

    expect(out).not.toContain('display:none');
    expect(out).not.toContain('body{');
    expect(out).toContain('hi');
  });

  it('drops every on* handler attribute', () => {
    const out = sanitize('<img src="https://cdn.example/a.png" onerror="alert(1)"><p onclick="x()">t</p>');

    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('alert(1)');
  });

  it('drops an iframe, which could frame the app itself', () => {
    const out = sanitize('<iframe src="https://evil.example/"></iframe><p>ok</p>');

    expect(out).not.toContain('iframe');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('ok');
  });

  it('drops form controls', () => {
    const out = sanitize('<form action="https://evil.example"><input name="x"><button>go</button></form>');

    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('<button');
  });
});

describe('sanitizeArticleHtml — URLs', () => {
  it('refuses a javascript: link but keeps its text', () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>');

    expect(out).not.toContain('javascript:');
    expect(out).toContain('click');
  });

  it('refuses javascript: obfuscated with a control character', () => {
    // `java\nscript:` is the canonical bypass of a prefix check; the parser
    // strips the newline so the scheme must be judged after stripping too.
    const out = sanitize('<a href="java\nscript:alert(1)">click</a>');

    expect(out).not.toContain('script:');
    expect(out).toContain('click');
  });

  it('refuses a data: URL as an image', () => {
    const out = sanitize('<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">');

    expect(out).not.toContain('img');
    expect(out).not.toContain('PHNjcmlwdD');
  });

  it('accepts a data: URL that is an image', () => {
    // Legitimate: feeds embed small inline images this way.
    const out = sanitize('<img src="data:image/png;base64,iVBORw0KGgo=">');

    expect(out).toContain('data:image/png');
  });

  it('resolves a relative image against the article, not the extension', () => {
    // Chrome resolves a bare `/img.png` on a chrome-extension:// page against the
    // extension itself, so it 404s; it has to become the feed's own URL.
    const out = sanitize('<img src="/media/cover.png">');

    expect(out).toContain('https://feed.example/media/cover.png');
  });

  it('opens links in a new tab without handing over the opener', () => {
    const container = parse('<a href="https://example.com/x">link</a>');
    const anchor = container.querySelector('a')!;

    expect(anchor.getAttribute('href')).toBe('https://example.com/x');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toContain('noopener');
  });

  it('drops a link whose href cannot be resolved, keeping the text', () => {
    const out = sanitize('<a href="mailto:a@b.c">mail</a>');

    expect(out).not.toContain('mailto');
    expect(out).toContain('mail');
  });
});

describe('sanitizeArticleHtml — structure', () => {
  it('keeps the article structure a reader needs', () => {
    const container = parse(
      '<h2>要闻</h2><p>正文 <strong>粗</strong></p><ul><li>项</li></ul>' +
        '<figure><img src="https://cdn.example/a.png" alt="图"><figcaption>说明</figcaption></figure>',
    );

    expect(container.querySelector('h2')?.textContent).toBe('要闻');
    expect(container.querySelector('p strong')?.textContent).toBe('粗');
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(container.querySelector('figcaption')?.textContent).toBe('说明');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/a.png');
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('图');
  });

  it('lazy-loads article images', () => {
    // A 23-image article must not fire every request the moment the reader opens.
    const container = parse('<img src="https://cdn.example/a.png">');
    const img = container.querySelector('img')!;

    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('unwraps an unknown element instead of deleting its content', () => {
    const out = sanitize('<section><p>kept</p></section>');

    expect(out).not.toContain('<section');
    expect(out).toContain('kept');
  });

  it('drops class, id and style, which the reader replaces with its own', () => {
    const container = parse('<p class="x" id="y" style="display:none">t</p>');
    const paragraph = container.querySelector('p')!;

    expect(paragraph.hasAttribute('class')).toBe(false);
    expect(paragraph.hasAttribute('id')).toBe(false);
    expect(paragraph.hasAttribute('style')).toBe(false);
    expect(paragraph.textContent).toBe('t');
  });

  it('drops an SVG subtree rather than unwrapping it', () => {
    // SVG is a different namespace: `<a>` in it is not an HTML anchor, and
    // unwrapping could rebuild it as one carrying an uninspected `xlink:href`.
    const out = sanitize('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');

    expect(out).not.toContain('svg');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('xlink');
  });

  it('keeps a table intact', () => {
    const container = parse('<table><tr><th>h</th></tr><tr><td colspan="2">d</td></tr></table>');

    expect(container.querySelectorAll('tr')).toHaveLength(2);
    expect(container.querySelector('td')?.getAttribute('colspan')).toBe('2');
  });

  it('drops a nonsensical numeric attribute but keeps the element', () => {
    // Inside a table, or the parser discards the stray cell before the
    // sanitizer ever sees it.
    const container = parse('<table><tr><td colspan="javascript:alert(1)">d</td></tr></table>');

    expect(container.querySelector('td')).not.toBeNull();
    expect(container.querySelector('td')!.hasAttribute('colspan')).toBe(false);
    expect(container.querySelector('td')!.textContent).toBe('d');
  });
});

describe('sanitizeArticleHtml — bounds', () => {
  it('stops emitting once the character budget is spent', () => {
    const many = '<p>' + 'x'.repeat(100) + '</p>';
    const container = document.createElement('div');
    container.innerHTML = many.repeat(50);
    const out = sanitizeArticleHtml(container, 'https://feed.example/post/1', 250);

    // Bounded, and still valid markup (no half-written tag at the cut).
    expect(out.length).toBeLessThan(1200);
    expect(out.endsWith('>')).toBe(true);
  });

  it('leaves an empty result for an empty article', () => {
    expect(sanitize('')).toBe('');
  });
});

describe('hasArticleMarkup', () => {
  it('detects real structure', () => {
    expect(hasArticleMarkup('<p>hi</p>')).toBe(true);
    expect(hasArticleMarkup('<img src="x">')).toBe(true);
  });

  it('reports plain text as having none', () => {
    // Callers store the plain-text path in that case, so the feed's own line
    // breaks survive instead of being collapsed by an HTML render.
    expect(hasArticleMarkup('just text, no tags')).toBe(false);
    expect(hasArticleMarkup('')).toBe(false);
    expect(hasArticleMarkup('a < b and c > d')).toBe(false);
  });
});
