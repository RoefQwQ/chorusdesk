// Capture README screenshots from a throwaway Chrome + the real built extension.
//
// Every safety property here exists because getting it wrong is not recoverable by
// `git revert` — the user's browser is the one thing this project must never disturb
// (AGENTS rule 25):
//
//  - A DEDICATED `--user-data-dir`, always passed. Never invoke Chrome without it:
//    a `chrome.exe` call that omits it is handed to the user's RUNNING instance,
//    which opens a tab in their window (seen 2026-09-13 while merely trying to read
//    `--version`).
//  - HEADLESS when it works. A headless browser has no window at all, which is
//    strictly better than minimizing one. Probed at startup rather than assumed.
//  - CDP `Browser.setWindowBounds` minimization for the headed fallback — NOT
//    `--window-position`, which is honoured but leaves the window in the taskbar
//    and on any display at negative coordinates (rule 28, measured).
//  - Synthesized content only. Avatars and covers are `data:` URLs and every name
//    is invented, so the images cannot leak who the user follows. Nothing touches
//    the network.
//  - The whole profile is deleted on exit, on success or failure.
//
// Usage: node e2e/screenshots.mjs [--headed] [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const EXT = path.join(REPO, '.output', 'chrome-mv3');
const OUT = path.join(REPO, 'docs', 'images');
const FORCE_HEADED = process.argv.includes('--headed');
const KEEP_PROFILE = process.argv.includes('--keep');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const hit = CHROME_CANDIDATES.find((c) => fs.existsSync(c));
  if (!hit) throw new Error('Chrome not found; set CHROME_PATH');
  return hit;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`cannot reach CDP at ${wsUrl}`));
  });
  let n = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const send = (method, params = {}, sessionId) => {
    const p = new Promise((resolve, reject) => pending.set(++n, { resolve, reject }));
    ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params }));
    return p;
  };
  return { send, close: () => ws.close() };
}

/** Keep a headed window out of the way; no-op when headless. */
async function hideWindow(cdp, headless) {
  if (headless || process.env.CI) return;
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) return;
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } catch {
    /* nothing to hide */
  }
}

async function launch({ headless }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-shots-'));
  const args = [
    `--user-data-dir=${profile}`, // MUST come first; see the header.
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=1440,900',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const child = spawn(findChrome(), args, { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) { child.kill(); throw new Error('Chrome opened no debug port in 30s'); }
    await sleep(150);
  }
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split('\n');
  const cdp = await connect(`ws://127.0.0.1:${Number(port)}${wsPath.trim()}`);
  return { child, cdp, profile };
}

/** Synthetic avatars/covers: an inline SVG in a clearly-fake palette. */
function swatchDataUrl(seed, size = 200) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue},70%,62%)"/>`
    + `<stop offset="1" stop-color="hsl(${(hue + 48) % 360},70%,44%)"/>`
    + `</linearGradient></defs>`
    + `<rect width="${size}" height="${size}" fill="url(#g)"/>`
    + `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 5}" fill="rgba(255,255,255,.45)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * The fake library.
 *
 * Names are invented and deliberately bland so they cannot be mistaken for real
 * accounts; the platform mix mirrors what the app supports so the UI shows its real
 * range. Image URLs are `data:` so nothing is fetched.
 */
function fixture(now) {
  const creators = [
    { name: '示例画师 A', platforms: ['bilibili', 'twitter'], tags: ['插画', '原创'], posts: 3 },
    { name: '示例博主 B', platforms: ['weibo'], tags: ['资讯'], posts: 2 },
    { name: '示例 UP 主 C', platforms: ['bilibili', 'youtube'], tags: ['教程'], posts: 2 },
    { name: '示例作者 D', platforms: ['pixiv', 'twitter'], tags: ['漫画'], posts: 2 },
    { name: '示例频道 E', platforms: ['rss'], tags: ['博客'], posts: 2 },
  ];
  const out = { creators: [], channels: [], posts: [] };
  let ci = 0;
  for (const c of creators) {
    const creatorId = `demo_creator_${ci}`;
    out.creators.push({
      id: creatorId,
      name: c.name,
      avatar: swatchDataUrl(c.name, 128),
      tags: c.tags,
      sortOrder: ci,
      createdAt: now,
      updatedAt: now,
    });
    let pi = 0;
    for (const platform of c.platforms) {
      const channelId = `${platform}:demo${ci}_${pi}`;
      out.channels.push({
        id: channelId,
        creatorId,
        platform,
        accountId: `demo${ci}${pi}`,
        displayName: `${c.name} · ${platform}`,
        label: pi === 0 ? '主账号' : '小号',
        accountRole: pi === 0 ? 'main' : 'sub',
        profileUrl: `https://example.invalid/${platform}/demo${ci}${pi}`,
        status: 'success',
        lastCheckAt: now - 3_600_000,
      });
      for (let k = 0; k < c.posts; k++) {
        const px = 900;
        out.posts.push({
          id: `${platform}_demo_${ci}_${pi}_${k}`,
          creatorId,
          channelId,
          platform,
          channelLabel: pi === 0 ? '主账号' : '小号',
          title: `${c.name} 的示例动态 ${k + 1}`,
          content: `这是用于文档截图的合成内容，不含任何真实账号信息。\n平台：${platform}　序号：${k + 1}`,
          mediaList: k === 0
            ? [{ type: 'image', previewUrl: swatchDataUrl(`${platform}${ci}${k}`, px), originalUrl: swatchDataUrl(`${platform}${ci}${k}`, px) }]
            : [],
          originalUrl: `https://example.invalid/${platform}/post/${ci}${pi}${k}`,
          publishedAt: now - (ci * 5 + k) * 3_600_000,
          fetchedAt: now,
          isRead: k === 1 ? 1 : 0,
          isBookmarked: k === 0 ? 1 : 0,
          authorMeta: { name: c.name, avatar: swatchDataUrl(c.name, 128) },
        });
      }
      pi++;
    }
    ci++;
  }
  return out;
}

/** Runs in the page: seed IndexedDB directly (the app reads these tables). */
function seedScript(data) {
  return `(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('CreatorFeedHubDB');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const put = (store, rows) => new Promise((res, rej) => {
      if (!db.objectStoreNames.contains(store)) return res();
      const tx = db.transaction(store, 'readwrite');
      for (const row of rows) tx.objectStore(store).put(row);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    await put('creators', ${JSON.stringify(data.creators)});
    await put('channels', ${JSON.stringify(data.channels)});
    await put('posts', ${JSON.stringify(data.posts)});
    await put('settings', [{ key: 'app_settings', value: { itemsPerFetch: 20, enableAutoSync: true, requestDelayMs: 600, theme: 'light' } }]);
    db.close();
    return { creators: ${data.creators.length}, posts: ${data.posts.length} };
  })()`;
}

const main = async () => {
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
    throw new Error(`build first: ${EXT} missing (npm run build)`);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // Probe headless first: no window beats a minimized one.
  let session;
  let headless = !FORCE_HEADED;
  const tryLoad = async (s) => {
    const { id } = await s.cdp.send('Extensions.loadUnpacked', { path: EXT });
    if (!id) throw new Error('loadUnpacked returned no extension id');
    s.extId = id;
    return id;
  };
  try {
    session = await launch({ headless });
    await tryLoad(session);
    console.log(`launched ${headless ? 'HEADLESS (no window at all)' : 'headed (minimized)'}`);
  } catch (err) {
    if (!headless) throw err;
    console.log(`headless could not load the extension (${err.message}); falling back to a minimized window`);
    try { session?.child.kill(); } catch { /* gone */ }
    fs.rmSync(session.profile, { recursive: true, force: true });
    headless = false;
    session = await launch({ headless });
    await tryLoad(session);
    console.log('launched headed (minimized)');
  }

  const { child, cdp, profile, extId } = session;
  const cleanup = async () => {
    try { await hideWindow(cdp, headless); } catch { /* gone */ }
    try { await cdp.send('Browser.close'); } catch { child.kill(); }
    await sleep(500);
    try { child.kill(); } catch { /* gone */ }
    if (!KEEP_PROFILE) {
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(200); }
      }
    } else {
      console.log(`profile kept at ${profile}`);
    }
  };
  process.on('exit', () => { try { child.kill(); } catch { /* gone */ } });

  try {
    // `Extensions.loadUnpacked` may have already run in the probe for the headless
    // path; loading twice is harmless but returns no id, so just confirm the worker.
    // Identify OUR extension by the id `loadUnpacked` returned, never by "the
    // first service_worker on screen". A headed Chrome carries other extensions'
    // workers too (measured: two, ours plus a system one), and picking the wrong
    // one produced `chrome-error://chromewebdata/` — a failed navigation whose
    // cause looked like a broken build.
    let worker = null;
    for (let i = 0; i < 60 && !worker; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      worker = targetInfos.find(
        (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`),
      );
      if (!worker) await sleep(200);
    }
    if (!worker) throw new Error(`no service worker for the loaded extension ${extId}`);
    console.log(`service worker up: ${worker.url.split('/').pop()}`);

    console.log(`extension id: ${extId}`);
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/dashboard.html` });

    await hideWindow(cdp, headless);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'eval failed');
      return result.value;
    };
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    // If the navigation failed, the document is `chrome-error://chromewebdata/`
    // with an opaque origin — no IndexedDB, no usable storage. Retry once with an
    // explicit navigate, since creating the target immediately after loadUnpacked
    // can race the extension's registration.
    {
      const href = await evaluate(`location.href`).catch(() => '');
      if (href.startsWith('chrome-error://')) {
        console.log(`page did not load (${href}); retrying navigation`);
        await cdp.send('Page.navigate', { url: `chrome-extension://${extId}/dashboard.html` }, sessionId);
        await sleep(1500);
      }
    }

    // Wait until we are actually on the extension page before touching its storage:
    // attaching to a freshly created target can still see `about:blank`, whose
    // origin has no accessible `localStorage` (SecurityError).
    for (let i = 0; i < 80; i++) {
      const href = await evaluate(`location.href`);
      if (href.startsWith('chrome-extension://')) break;
      await sleep(200);
    }
    // Then wait for Vue to mount, so Dexie has created its object stores.
    for (let i = 0; i < 80; i++) {
      if (await evaluate(`Boolean(document.querySelector('#app')?.firstElementChild)`)) break;
      await sleep(200);
    }
    await evaluate(`(() => { try { localStorage.setItem('creator_feed_theme','light'); } catch {} return location.href; })()`);

    const now = Date.now();
    const data = fixture(now);
    const diag = await evaluate(`({
      href: location.href,
      origin: location.origin,
      hasIDB: typeof indexedDB !== 'undefined',
      hasChrome: typeof chrome !== 'undefined',
      appHtml: (document.querySelector('#app')?.innerHTML || '').slice(0, 80),
    })`);
    console.log('page diagnostic:', JSON.stringify(diag));
    const seeded = await evaluate(seedScript(data));
    console.log(`seeded ${seeded.creators} creators / ${seeded.posts} posts (all synthetic)`);

    // Force a full re-read so the seeded rows render.
    await evaluate(`location.reload()`);
    await sleep(1200);
    for (let i = 0; i < 80; i++) {
      const ready = await evaluate(`document.querySelectorAll('article, [data-post-id], img').length`);
      if (ready > 4) break;
      await sleep(200);
    }

    const shot = async (name, prepare) => {
      if (prepare) {
        const res = await evaluate(prepare);
        console.log(`  ${name}: ${JSON.stringify(res)}`);
        await sleep(1200);
      }
      const { data: b64 } = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false },
        sessionId,
      );
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      const { width, height } = await evaluate(`({width: innerWidth, height: innerHeight})`);
      console.log(`  wrote ${path.relative(REPO, file)} (${width}x${height} css px, 2x)`);
    };

    // 1) Feed: the default tab; click it explicitly so the capture is deterministic.
    await shot('feed', `(() => {
      const nav = document.querySelector('nav');
      const tab = [...(nav ? nav.querySelectorAll('button') : [])]
        .find(b => (b.textContent || '').trim().startsWith('动态'));
      if (!tab) return { clicked: false, navFound: Boolean(nav) };
      tab.click();
      return { clicked: true, label: tab.textContent.trim() };
    })()`);

    // 2) Creators: the 关注 tab, where account grouping and role labels show.
    await shot('creators', `(() => {
      const nav = document.querySelector('nav');
      const tab = [...(nav ? nav.querySelectorAll('button') : [])]
        .find(b => (b.textContent || '').trim().startsWith('关注'));
      if (!tab) return { clicked: false, navFound: Boolean(nav) };
      tab.click();
      return { clicked: true, label: tab.textContent.trim() };
    })()`);

    console.log('done');
  } finally {
    await cleanup();
  }
};

main().catch((err) => {
  console.error(`screenshots failed: ${err.message}`);
  process.exit(1);
});
