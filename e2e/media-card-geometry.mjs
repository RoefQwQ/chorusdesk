// Media-card geometry probe: is a card's image shown WHOLE, and at what box?
//
// Answers a question no unit test can: what box does a single-image card actually
// give its artwork, and does `object-fit` then crop it. jsdom reports every height
// as 0, so the numbers only exist in a real layout engine (AGENTS rules 30, 28).
//
// Written for the 2026-09-14 defect: the user reported pixiv cards that showed
// 「只显示一部分图片」. Measured here on a real build — a 900x1200 work in a 433px
// column was given a 433x460 holder, because `max-h-[460px]` capped the height the
// ratio asked for (577px). The box ratio became 0.94 against the image's 0.75, so
// `object-cover` cut the sides off. Only works whose ratio is below the column's
// are affected; landscape ones (ratio >= 1) never were, which is why the report
// named specific works.
//
// Prints one line per card: the artwork's natural size, the holder box, the
// <img> box, the applied `object-fit`, and whether that combination crops.
//
//   node e2e/media-card-geometry.mjs                    # 1568x898 (the reporter's window)
//   node e2e/media-card-geometry.mjs --width 2100       # wider columns
//
// Add `--shot <file>` to also write a full-page PNG.
//
// The six works below are PUBLIC pixiv artworks, chosen because their ratios cover
// both sides of the failure boundary. They are referenced by URL, not downloaded:
// i.pximg.net needs a pixiv Referer, which the extension's own DNR rule supplies
// (rule 1002) — that is also why this runs inside the extension page rather than
// on a bare about:blank.
//
// Uses its OWN profile, never the user's running browser (AGENTS rule 25).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SHOT = argOf('--shot', null);
const WIDTH = Number(argOf('--width', 1568));
const HEIGHT = Number(argOf('--height', 898));

const CHROME =
  argOf('--chrome', null) ||
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(CHROME)) throw new Error('chrome not found: ' + CHROME);
const EXT = path.resolve(argOf('--extension', '.output/chrome-mv3'));
if (!fs.existsSync(EXT)) throw new Error('build the extension first: npm run build');

// Public works. `w`/`h` are the real master1200 dimensions, measured, and are what
// the assertions below are written against.
const WORKS = [
  { id: '146289897', d: '2026/06/21/21/19/54', w: 801, h: 1200 }, // portrait, ratio 0.67
  { id: '146161559', d: '2026/06/18/21/06/28', w: 900, h: 1200 }, // portrait, ratio 0.75
  { id: '146892429', d: '2026/07/06/19/36/10', w: 1200, h: 1200 }, // square
  { id: '147201239', d: '2026/07/14/21/20/20', w: 1200, h: 800 }, // landscape, ratio 1.5
  { id: '146616166', d: '2026/06/29/21/09/08', w: 1200, h: 800 },
  { id: '145903933', d: '2026/06/12/11/03/42', w: 1198, h: 799 },
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'media-geometry-'));
const child = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  '--remote-allow-origins=*',
  // Without this the CDP extension load fails with `Method not available` (rule 28).
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  `--window-size=${WIDTH},${HEIGHT}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const portFile = path.join(profile, 'DevToolsActivePort');
for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 150));
const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split('\n');

const ws = new WebSocket(`ws://127.0.0.1:${Number(port)}${wsPath.trim()}`);
const pending = new Map();
let msgId = 0;
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const myId = ++msgId;
  pending.set(myId, (m) => (m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)));
  ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: EXT });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  };

  await send('Page.navigate', { url: `chrome-extension://${extId}/dashboard.html` }, sessionId);
  for (let i = 0; i < 120; i++) {
    const r = await send('Runtime.evaluate', { expression: 'document.readyState === "complete"', returnByValue: true }, sessionId);
    if (r.result.value) break;
    await sleep(150);
  }
  await sleep(2500);

  // Seed straight into IndexedDB: this probe is about the RENDER, so going through
  // the settings import UI would only add two failure modes that are not its subject.
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const seeded = await evaluate(`(async () => {
    const WORKS = ${JSON.stringify(WORKS.map((w) => ({ id: w.id, d: w.d })))};
    const now = ${now};
    const db = await new Promise((res, rej) => { const q = indexedDB.open('CreatorFeedHubDB'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const put = (store, rows) => new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      rows.forEach((r) => s.put(r));
      tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
    });
    await put('creators', [{ id: 'r_probe', name: '几何探针', avatar: '', tags: [], note: '', sortOrder: 0, createdAt: now, updatedAt: now }]);
    await put('channels', [{ id: 'c_probe', creatorId: 'r_probe', platform: 'pixiv', accountId: 'probe', displayName: '几何探针', label: '', accountRole: 'main', profileUrl: 'https://www.pixiv.net/', status: 'success' }]);
    await put('posts', WORKS.map((w, i) => ({
      id: 'pixiv_' + w.id, creatorId: 'r_probe', channelId: 'c_probe', platform: 'pixiv',
      title: 'Pixiv 插画/作品 #' + w.id,
      content: '作品 ID: ' + w.id + ' (点击卡片直达原图查看)',
      mediaList: [{
        type: 'image',
        previewUrl: 'https://i.pximg.net/img-master/img/' + w.d + '/' + w.id + '_p0_master1200.jpg',
        originalUrl: 'https://i.pximg.net/img-original/img/' + w.d + '/' + w.id + '_p0.jpg',
      }],
      originalUrl: 'https://www.pixiv.net/artworks/' + w.id,
      publishedAt: now - i * 86400000, fetchedAt: now,
      isRead: 1, isBookmarked: 0, channelLabel: '',
    })));
    const n = await new Promise((res) => { const q = db.transaction('posts', 'readonly').objectStore('posts').count(); q.onsuccess = () => res(q.result); });
    db.close();
    return { posts: n };
  })()`);
  console.log('seeded:', JSON.stringify(seeded), `viewport ${WIDTH}x${HEIGHT}`);

  // Reload so the app reads what was just written.
  await send('Page.reload', {}, sessionId);
  await sleep(6000);

  const report = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Wait for every image to settle. A card gated on its disk probe, or one whose
    // request is still in flight, would otherwise be measured as a placeholder and
    // read as a geometry bug (that is the whole reason this is an explicit wait).
    for (let i = 0; i < 60; i++) {
      const imgs = [...document.querySelectorAll('article img')];
      if (imgs.length && imgs.every((im) => im.complete)) break;
      await sleep(500);
    }
    const out = [];
    for (const card of document.querySelectorAll('article')) {
      const title = (card.querySelector('h5') || {}).textContent || '';
      const idm = /#(\\d+)/.exec(title);
      const img = card.querySelector('img');
      const holder = img ? img.parentElement : null;
      const box = holder ? holder.getBoundingClientRect() : null;
      const ir = img ? img.getBoundingClientRect() : null;
      const cs = img ? getComputedStyle(img) : null;
      let crop = null;
      if (img && img.naturalWidth && cs && box && box.width && box.height) {
        const srcRatio = img.naturalWidth / img.naturalHeight;
        const boxRatio = box.width / box.height;
        crop = cs.objectFit === 'cover'
          ? (Math.abs(srcRatio - boxRatio) < 0.01 ? 'complete' : 'CROPS')
          : 'complete (contain)';
      }
      out.push({
        id: idm ? idm[1] : '?',
        natural: img && img.naturalWidth ? img.naturalWidth + 'x' + img.naturalHeight : null,
        holder: box ? Math.round(box.width) + 'x' + Math.round(box.height) : null,
        imgBox: ir ? Math.round(ir.width) + 'x' + Math.round(ir.height) : null,
        objectFit: cs ? cs.objectFit : null,
        crop,
      });
    }
    return out;
  })()`);

  console.log('\nid           natural       holder        objectFit   result');
  let crops = 0, missing = 0;
  for (const r of report) {
    if (!r.natural) { missing++; console.log(`${r.id}   (image did not load)`); continue; }
    if (r.crop === 'CROPS') crops++;
    console.log(`${r.id}  ${String(r.natural).padEnd(12)}  ${String(r.holder).padEnd(12)}  ${String(r.objectFit).padEnd(10)}  ${r.crop}`);
  }
  console.log(`\n${report.length} cards: ${crops} cropping, ${missing} not loaded`);

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    if (shot && shot.data) {
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log('screenshot ->', SHOT);
    } else {
      console.log('screenshot unavailable (the window is not composited — rule 30)');
    }
  }

  process.exitCode = crops > 0 || missing > 0 ? 1 : 0;
} finally {
  await send('Browser.close').catch(() => {});
  await sleep(400);
  child.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* chrome may still hold it */ }
}
