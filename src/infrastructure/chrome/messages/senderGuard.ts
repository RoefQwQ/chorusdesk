/**
 * Sender validation for privileged background message handlers.
 *
 * `chrome.runtime.onMessage` fires for the extension's own pages, its content
 * scripts, and — if `externally_connectable` is ever declared — web pages and
 * other extensions. Handlers that fetch with the user's cookies or read stored
 * tokens must therefore verify who is asking rather than relying on the
 * manifest's current default-deny posture.
 */

/**
 * True when the message came from one of the extension's own pages
 * (dashboard / popup), i.e. a `chrome-extension://<our id>` origin.
 *
 * Content scripts fail this check: they share the extension id but their
 * `origin`/`url` is the host page's.
 */
export function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const expectedOrigin = `chrome-extension://${chrome.runtime.id}`;
  if (sender.origin) return sender.origin === expectedOrigin;
  // `origin` is absent on older builds; fall back to the frame URL.
  return typeof sender.url === 'string' && sender.url.startsWith(`${expectedOrigin}/`);
}

/**
 * True when the message came from one of our own content scripts running on
 * `host` (or a subdomain of it) — used to accept the rplay.live token relay
 * without opening privileged handlers to every injected frame.
 */
export function isContentScriptSenderOn(
  sender: chrome.runtime.MessageSender,
  host: string,
): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (typeof sender.url !== 'string') return false;
  try {
    const { hostname } = new URL(sender.url);
    const base = host.toLowerCase();
    const name = hostname.toLowerCase();
    return name === base || name.endsWith(`.${base}`);
  } catch {
    return false;
  }
}
