/**
 * Which element holds a creator's AVATAR on a platform profile page?
 *
 * The popup's generic in-page script has branches for some platforms and a
 * `meta[property="og:image"]` fallback for the rest, and on several of those the
 * fallback is not the avatar. Writing a selector from server HTML does not work
 * for the client-rendered ones, so this opens a real (isolated) browser and reports
 * every candidate with its measured size, class, alt and parent.
 *
 * Measured with this tool, 2026-09-13:
 *   - pixiv : `og:image` is `https://embed.pixiv.net/user_profile.php?id=…&k=…`
 *             (a dynamic embed page) even for an account WITH an avatar; the real
 *             one is in the profile API's `imageBig`.
 *   - fantia: `og:image` is the OGC cover; the avatar is `img.img-circle` whose src
 *             contains `fanclub/icon_image/<fanclub id>/`. The page also renders
 *             six unrelated 86x86 `img-circle` avatars for a "related creators"
 *             strip, so the class alone is not enough.
 *
 * Isolation (AGENTS rules 25/28): its OWN Chrome with a fresh `--user-data-dir`,
 * minimized via CDP — `--window-position` alone is NOT enough. Profile deleted on
 * exit. Read-only: navigates and reads the DOM; no clicks, no login, no writes.
 *
 * Usage:
 *   node e2e/avatar-probe.mjs <url> [<url> ...]
 *   CHROME_PATH=/path/to/chrome node e2e/avatar-probe.mjs https://fantia.jp/fanclubs/900001
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const urls = process.argv.slice(2).filter((a) => /^https?:/.test(a));
if (urls.length === 0) {
  console.error('usage: node e2e/avatar-probe.mjs <url> [<url> ...]');
  process.exit(2);
}

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} — set CHROME_PATH.`);
  process.exit(2);
}

/** Give a client-rendered SPA time to hydrate before reading its DOM. */
const HYDRATE_MS = Number(process.env.HYDRATE_MS || 7000);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-probe-'));
const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`, // MUST come first; see the header.
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
if (!fs.existsSync(portFile)) {
  child.kill();
  throw new Error('Chrome opened no debug port in 30s');
}
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

async function hideWindow() {
  try {
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) return;
    const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.targetId });
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } catch {
    /* nothing to hide */
  }
}

/** Runs in the page. Reports every image plus the meta tags the fallback reads. */
const INSPECT = `(() => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const cls = (el) => (el && typeof el.className === 'string' ? el.className.slice(0, 110) : '');
  const imgs = [...document.querySelectorAll('img')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      src: abs(el.currentSrc || el.src || ''),
      alt: el.alt || '',
      cls: cls(el),
      id: el.id || '',
      parent: cls(el.parentElement),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  }).filter((i) => i.src && !i.src.startsWith('data:'));
  const meta = {};
  for (const p of ['og:image', 'og:title']) {
    const el = document.querySelector('meta[property="' + p + '"]');
    if (el) meta[p] = abs(el.content);
  }
  return {
    href: location.href,
    title: document.title,
    meta,
    squareish: imgs.filter((i) => i.w > 24 && Math.abs(i.w - i.h) < 4).slice(0, 14),
    imgTotal: imgs.length,
  };
})()`;

let ok = false;
try {
  await hideWindow();
  for (const url of urls) {
    console.log(`\n================= ${url} =================`);
    const { targetId } = await send('Target.createTarget', { url });
    await sleep(HYDRATE_MS); // client-rendered: loading is not rendering (rule 17)
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    const { result, exceptionDetails } = await send(
      'Runtime.evaluate',
      { expression: INSPECT, returnByValue: true },
      sessionId,
    );
    if (exceptionDetails) {
      console.log('eval failed:', exceptionDetails.exception?.description);
    } else {
      const d = result.value;
      console.log(`title: ${d.title}`);
      console.log(`images: ${d.imgTotal}   (meta fallback reads these:)`);
      console.log(`  og:image => ${d.meta['og:image'] ?? '(none)'}`);
      console.log(`  og:title => ${d.meta['og:title'] ?? '(none)'}`);
      console.log(`\nsquare-ish candidates (${d.squareish.length}):`);
      for (const c of d.squareish) {
        console.log(`  ${c.w}x${c.h}  id=${c.id || '-'}  parent=${c.parent || '-'}`);
        console.log(`     cls=${c.cls || '-'}`);
        console.log(`     alt=${JSON.stringify(c.alt)}`);
        console.log(`     src=${c.src.slice(0, 140)}`);
      }
    }
    await send('Target.closeTarget', { targetId });
  }
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
  for (let i = 0; i < 12; i++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(250);
    }
  }
}
console.log(ok ? '\ndone (profile deleted)' : '\nprobe did not complete');
