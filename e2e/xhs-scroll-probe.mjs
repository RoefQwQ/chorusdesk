/**
 * Does the xiaohongshu profile page load more notes when its feed is scrolled?
 *
 * This is the load-bearing question for the history work. The adapter's current
 * "dig" is a LOCAL offset over the ~30 notes the SSR payload carries, so it can
 * never reach anything older. Two ways out were proposed:
 *
 *   A. scroll the page so its own lazy loader fetches more, then read the DOM;
 *   B. call the signed `user_posted` endpoint from inside the page context.
 *
 * A only works if scrolling actually produces more notes. This measures it, and
 * also reports which element scrolls (AGENTS rule 10: the window is often NOT the
 * container — driving the wrong one looks exactly like "no pagination exists").
 *
 * Read-only: loads the page, scrolls its feed, counts rendered note links. No
 * clicks on any control, no login, nothing written.
 *
 * LOGIN: xiaohongshu redirects an anonymous visitor to `/login?redirectPath=…`, so
 * this probe sees a login page and 0 notes unless it runs against a signed-in
 * profile. Set `XHS_PROFILE` to a profile directory to reuse it (kept afterwards,
 * so a login survives between runs):
 *
 *   XHS_PROFILE=~/.cache/chorus-xhs node e2e/xhs-scroll-probe.mjs
 *
 * Without it a throwaway profile is used and deleted.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url =
  process.argv[2] || 'https://www.xiaohongshu.com/user/profile/63799a52000000001f01ca92';
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} — set CHROME_PATH.`);
  process.exit(2);
}

// Reuse a signed-in profile when asked to; otherwise throw one away afterwards.
const reuseProfile = process.env.XHS_PROFILE ? path.resolve(process.env.XHS_PROFILE) : null;
const profile = reuseProfile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-scroll-'));
fs.mkdirSync(profile, { recursive: true });
if (reuseProfile) console.log(`profile: ${profile} (kept)`);
const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--window-size=1400,900',
    '--window-position=-2400,-2400',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFile = path.join(profile, 'DevToolsActivePort');
for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await sleep(150);
const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split('\n');

const ws = new WebSocket(`ws://127.0.0.1:${Number(port)}${wsPath.trim()}`);
const pending = new Map();
let id = 0;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
  });

// Keep the window off the user's screen (rule 25/28: minimize, do not just offset).
try {
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  if (page) {
    const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.targetId });
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  }
} catch {
  /* nothing to hide */
}

/** Count note links and describe every scrollable ancestor of the feed. */
const PROBE = `(() => {
  const noteLinks = () => document.querySelectorAll('a[href*="/explore/"], a[href*="/user/profile/"][href*="note"]').length;
  const scrollables = [...document.querySelectorAll('*')].filter(
    (el) => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200,
  ).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: typeof el.className === 'string' ? el.className.slice(0, 90) : '',
    id: el.id || '',
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  })).slice(0, 8);
  return {
    noteLinks: noteLinks(),
    docScrollTop: Math.round(document.scrollingElement?.scrollTop || 0),
    docScrollHeight: document.scrollingElement?.scrollHeight || 0,
    viewport: window.innerHeight,
    scrollables,
    hasSSRNotes: (() => {
      const s = document.documentElement.innerHTML;
      const i = s.indexOf('window.__INITIAL_STATE__');
      if (i === -1) return -1;
      const m = s.slice(i).match(/"notes":\\s*\\[/);
      return m ? 1 : 0;
    })(),
  };
})()`;

let ok = false;
try {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);

  const evalIn = async (expression) => {
    const { result, exceptionDetails } = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'eval failed');
    return result.value;
  };

  // Wait for the THING WE NEED, not a fixed sleep (rule 17: loading is not
  // rendering). A fixed 8s produced 60 note links on one run and 0 on the next —
  // a hydration race, which reads exactly like "this page has no feed".
  const deadline = Date.now() + 40_000;
  let ready = 0;
  for (;;) {
    ready = await evalIn(`document.querySelectorAll('a[href*="/explore/"]').length`).catch(() => 0);
    if (ready > 0) break;
    if (Date.now() > deadline) {
      const where = await evalIn(`location.href`).catch(() => '?');
      console.log(`!! no note links after 40s (at ${where}) — a login wall or a shape change`);
      break;
    }
    await sleep(500);
  }
  console.log(`feed rendered: ${ready} note links\n`);

  const before = await evalIn(PROBE);
  console.log('=== before scrolling ===');
  console.log(`note links rendered : ${before.noteLinks}`);
  console.log(`document scrollable : ${before.docScrollHeight} / viewport ${before.viewport}`);
  console.log(`scroll containers   : ${before.scrollables.length}`);
  for (const s of before.scrollables) {
    console.log(`   ${s.tag} id=${s.id || '-'} cls=${s.cls || '-'}`);
    console.log(`      scrollTop=${s.scrollTop} scrollHeight=${s.scrollHeight} clientHeight=${s.clientHeight}`);
  }

  // Drive EVERY scrollable ancestor plus the document, repeatedly. The whole point
  // is not to assume which one the feed listens to (rule 10).
  console.log('\n=== scrolling the feed ===');
  for (let round = 1; round <= 6; round++) {
    await evalIn(`(() => {
      const targets = [...document.querySelectorAll('*')].filter(
        (el) => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200,
      );
      for (const el of targets) el.scrollTop = el.scrollHeight;
      if (document.scrollingElement) document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
      window.dispatchEvent(new Event('scroll'));
      return targets.length;
    })()`);
    await sleep(2500);
    const now = await evalIn(`document.querySelectorAll('a[href*="/explore/"]').length`);
    console.log(`  round ${round}: ${now} note links`);
  }

  const after = await evalIn(PROBE);
  console.log('\n=== after scrolling ===');
  console.log(`note links rendered : ${after.noteLinks}  (was ${before.noteLinks})`);
  console.log(`document scrollable : ${after.docScrollHeight}`);
  for (const s of after.scrollables) {
    console.log(`   ${s.tag} id=${s.id || '-'} cls=${s.cls || '-'} scrollTop=${s.scrollTop} scrollHeight=${s.scrollHeight}`);
  }
  console.log(
    `\nVERDICT: scrolling ${after.noteLinks > before.noteLinks ? 'DOES' : 'does NOT'} produce more notes`,
  );
  ok = true;
} finally {
  try {
    await send('Browser.close');
  } catch {
    child.kill();
  }
  await sleep(600);
  try {
    child.kill();
  } catch {
    /* gone */
  }
  if (!reuseProfile) {
    for (let i = 0; i < 12; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
}
console.log(ok ? (reuseProfile ? 'done (profile kept)' : 'done (profile deleted)') : 'probe did not complete');
