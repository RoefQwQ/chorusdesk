// Refactor-verification capture tool for the feed view (动态).
//
// Same shape and the same purpose as `creators-render.mjs`: it answers one
// question during a refactor — "did anything observable change?" It loads the
// built extension, seeds a fixture through the real backup import path, drives a
// scripted sequence of interactions, and records the feed section's markup at
// every step.
//
//   node e2e/feed-render.mjs capture /tmp/before.json
//   # … change the view …
//   node e2e/feed-render.mjs capture /tmp/after.json
//   node e2e/feed-render.mjs diff /tmp/before.json /tmp/after.json
//
// It exists because `FeedView.vue`'s platform drag-and-drop and its masonry
// pagination were extracted into composables (2026-09-11, queue item B19). A move
// like that reads as obviously safe and has two specific ways to be wrong: the
// drop index arithmetic can silently reorder nothing, and the infinite-scroll
// observer can stop growing the page. Both are invisible to typecheck and lint, so
// both are driven here and asserted, not photographed.
//
// Every step also asserts its post-condition (the rendered feed count), because a
// click that silently did nothing would make the byte comparison vacuous
// (AGENTS rule 26).
//
// Requires the built extension (`npm run build`) and Chrome with
// `--enable-unsafe-extension-debugging`. Its profile is its own and is deleted on
// exit; it never touches a running browser (AGENTS rule 25).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODE = process.argv[2];

if (MODE === 'diff') {
  const [beforePath, afterPath] = process.argv.slice(3);
  if (!beforePath || !afterPath) {
    console.error('usage: node e2e/feed-render.mjs diff <before.json> <after.json>');
    process.exit(2);
  }
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
  const names = Object.keys(before);
  const onlyInAfter = Object.keys(after).filter((k) => !names.includes(k));
  const differing = [];
  for (const name of names) {
    if (before[name] === after[name]) continue;
    const x = before[name] ?? '';
    const y = after[name] ?? '';
    let i = 0;
    while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++;
    differing.push(
      `  ${name} @${i} (${x.length} → ${y.length})\n` +
        `      before: ${JSON.stringify(x.slice(Math.max(0, i - 110), i + 110))}\n` +
        `      after : ${JSON.stringify(y.slice(Math.max(0, i - 110), i + 110))}`,
    );
  }
  const bytes = (o) => names.reduce((n, k) => n + (o[k]?.length ?? 0), 0);
  console.log(`${names.length} steps compared (${bytes(before)} → ${bytes(after)} bytes)`);
  if (onlyInAfter.length) console.log(`  steps only in the second capture: ${onlyInAfter.join(', ')}`);
  if (!differing.length) {
    console.log('IDENTICAL — no observable difference in any step.');
    process.exit(0);
  }
  console.log(`DIFFERENT in ${differing.length} step(s):`);
  for (const d of differing) console.log(d);
  process.exit(1);
}

if (MODE !== 'capture' || !process.argv[3]) {
  console.error('usage: node e2e/feed-render.mjs capture <out.json> [--chrome <path>]');
  console.error('       node e2e/feed-render.mjs diff <before.json> <after.json>');
  process.exit(2);
}

const OUT = process.argv[3];
const chromeArgIndex = process.argv.indexOf('--chrome');
const CHROME =
  (chromeArgIndex > 0 && process.argv[chromeArgIndex + 1]) ||
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} — pass --chrome <path> or set CHROME_PATH.`);
  process.exit(2);
}

const EXT = path.resolve('.output/chrome-mv3');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-render-'));

const child = spawn(CHROME, [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-allow-origins=*',
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', '--window-size=1600,1000', '--window-position=-2400,-2400',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const portFile = path.join(profile, 'DevToolsActivePort');
while (!fs.existsSync(portFile)) await new Promise((r) => setTimeout(r, 150));
const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split('\n');

const ws = new WebSocket(`ws://127.0.0.1:${Number(port)}${wsPath.trim()}`);
const pending = new Map();
let id = 0;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(`${m.method}: ${m.error.message}`)) : p.resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { id: extId } = await send('Extensions.loadUnpacked', { path: EXT });
// Open about:blank, set the viewport, and only THEN navigate. Creating the
// target directly at dashboard.html let the app mount and take its first
// measurements against the default window size, and some of them are computed
// once — the creator-list scroll viewport measured 330px in one run and 370px in
// the next, from the same build.
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
// A tall viewport on purpose: the waterfall's column count is derived from
// `window.innerWidth` (768/1280 breakpoints) and the sidebar from `innerHeight`,
// so both dimensions are part of the fixture.
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url: `chrome-extension://${extId}/dashboard.html` }, sessionId);
for (let i = 0; i < 100; i++) {
  const ready = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
  if (ready.result?.value === 'complete') break;
  await sleep(100);
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// The feed is the only section that owns a 平台 sidebar with these pills; scope
// every query to it (the other views stay mounted in the document, so an
// unscoped querySelectorAll would click another view's control).
const PRELUDE = `
  // The feed is the section holding the platform sidebar; the other views stay
  // mounted, so every query is scoped to it.
  const sec = () => {
    const s = [...document.querySelectorAll('section')].find((x) => x.querySelector('[aria-label="平台列表"]'));
    if (!s) throw new Error('feed section not rendered');
    return s;
  };
  // PostCard is the only component in the app that renders an <article>.
  const cards = () => sec().querySelectorAll('article').length;
  // "已显示 36 / 80" while paging, "已显示全部 80 条动态" when done — the view's
  // own statement of the pagination window, which is what a broken observer moves.
  // Written without backslash escapes on purpose: this is inside an injected
  // template literal, where one level of escaping is silently eaten.
  const paging = () => (sec().textContent.match(/已显示[^0-9]*([0-9]+)(?:[^0-9]*\\/[^0-9]*([0-9]+))?/) || []).slice(1).join('/');
`;
const act = (body) => evaluate(`(() => { ${PRELUDE} ${body} })()`);
const navClick = (text) => evaluate(`(() => {
  const b = [...document.querySelectorAll('nav button')].find((x) => (x.textContent || '').includes(${JSON.stringify(text)}));
  if (!b) throw new Error('no nav button: ' + ${JSON.stringify(text)});
  b.click(); return true;
})()`);

const shots = {};
async function shot(label, action) {
  if (action) {
    const note = await action();
    if (note !== undefined && note !== true) console.log(`   [${label}] ${note}`);
  }
  await sleep(450);
  shots[label] = await evaluate(`(() => { ${PRELUDE} return sec().outerHTML; })()`);
}

// ---------------------------------------------------------------- seed
const now = Date.UTC(2026, 8, 11, 12, 0, 0);
const creator = (id, name) => ({ id, name, avatar: '', tags: [], note: '', sortOrder: 0, createdAt: now, updatedAt: now });
const chan = (id, creatorId, platform) => ({
  id, creatorId, platform, accountId: 'a_' + id, displayName: '昵称_' + id, label: '',
  accountRole: 'main', profileUrl: 'https://example.com/' + id, status: 'success',
});
// 80 posts across three platforms: enough to exceed one page (36) so the
// infinite-scroll step has something to load, and uneven body lengths so the
// masonry column packing has to make real choices.
//
// Timestamps step by DAYS, not minutes. The cards render a relative age
// ("3 小时前"), which is derived from the wall clock — so a minute-granularity
// fixture makes two captures of the SAME build differ as soon as a capture pair
// straddles an hour boundary. That happened: the first determinism check passed
// only because both captures fell inside one hour. Day granularity keeps the
// labels stable for a day, which is what a before/after pair needs.
// (Corollary: re-running this tool on a later day may legitimately show
// different relative labels. Check timestamps before believing a diff.)
const posts = [];
for (let i = 0; i < 80; i++) {
  const platform = i % 3 === 0 ? 'bilibili' : i % 3 === 1 ? 'twitter' : 'youtube';
  const channelId = platform === 'bilibili' ? 'c1' : platform === 'twitter' ? 'c2' : 'c3';
  posts.push({
    id: 'p' + i,
    creatorId: channelId === 'c1' ? 'r1' : channelId === 'c2' ? 'r2' : 'r3',
    channelId,
    platform,
    title: '标题' + i,
    content: '正文'.repeat((i % 7) + 1) + ' #标签' + (i % 4),
    mediaList: i % 4 === 0 ? [{ url: 'https://example.com/m' + i + '.jpg', type: 'image' }] : [],
    originalUrl: 'https://example.com/post/' + i,
    publishedAt: now - i * 86_400_000,
    fetchedAt: now,
    // Read on purpose. The feed marks each rendered post as read, which adds
    // `ring-1 ring-indigo-400/40` to the card — so an unread fixture makes the
    // capture race the mark-as-read write, and two runs of the same build differ
    // by that ring. Seeding `1` makes the marking a no-op and the styling stable.
    isRead: 1,
    isBookmarked: 0,
  });
}

const fixture = {
  version: '1.0', exportedAt: new Date(now).toISOString(),
  creators: [creator('r1', '甲甲'), creator('r2', '乙乙'), creator('r3', '丙丙')],
  channels: [chan('c1', 'r1', 'bilibili'), chan('c2', 'r2', 'twitter'), chan('c3', 'r3', 'youtube')],
  posts,
  settings: { itemsPerFetch: 10, enableAutoSync: false, platformOrder: [] },
};
const fixturePath = path.join(profile, 'feed-fixture.json');
fs.writeFileSync(fixturePath, JSON.stringify(fixture));

await sleep(1400);
await navClick('设置');
await sleep(400);
{
  const { root } = await send('DOM.getDocument', { depth: 1 }, sessionId);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".json"]' }, sessionId);
  if (!nodeId) throw new Error('import input not found');
  await send('DOM.setFileInputFiles', { nodeId, files: [fixturePath] }, sessionId);
}
await sleep(1400);
await send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});

const seeded = await evaluate(`(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('CreatorFeedHubDB'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const read = (s) => new Promise((res, rej) => { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const out = { creators: (await read('creators')).length, channels: (await read('channels')).length, posts: (await read('posts')).length };
  db.close(); return out;
})()`);
console.log('seeded:', JSON.stringify(seeded));
if (seeded.posts !== 80) throw new Error('fixture did not import: ' + JSON.stringify(seeded));

await navClick('动态');
await sleep(700);

// ---------------------------------------------------------------- capture
// The pagination window is the first thing a masonry/pagination refactor breaks,
// so it is read from the DOM (how many cards are rendered), not from the state.
await shot('01-initial');
const firstPage = await act(`return { cards: cards(), paging: paging() };`);
console.log('initial page:', JSON.stringify(firstPage));

await shot('02-platform-bilibili', () => act(`
  const b = [...sec().querySelectorAll('button')].find((x) => /哔哩哔哩/.test((x.textContent || '').trim()));
  if (!b) throw new Error('no bilibili pill');
  b.click(); return cards();`));
await shot('03-platform-all', () => act(`
  const b = [...sec().querySelectorAll('button')].find((x) => /^全部/.test((x.textContent || '').trim()));
  if (!b) throw new Error('no all pill');
  b.click(); return cards();`));
await shot('04-search', () => act(`
  const input = sec().querySelector('input[placeholder^="搜索内容或创作者"]');
  if (!input) throw new Error('no search input in the feed');
  input.value = '正文正文';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;`));
await shot('05-search-cleared', () => act(`
  const input = sec().querySelector('input[placeholder^="搜索内容或创作者"]');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;`));

// Infinite scroll. This window is off-screen and never composited, so no `scroll`
// event fires on its own (AGENTS rule 30). Drive it, then WAIT for the sentinel to
// be observed: a single scroll plus one synthetic event sometimes grew the page and
// sometimes did not, and a capture taken from the run where it did not would differ
// from every other capture for a reason that has nothing to do with the code under
// test. It is an assertion now — no silent "note".
const scrolled = await act(`
  const before = cards();
  window.scrollTo(0, document.body.scrollHeight);
  window.dispatchEvent(new Event('scroll'));
  return { cards: before, paging: paging() };`);
await shot('06-after-scroll');
const afterScroll = await act(`return { cards: cards(), paging: paging() };`);
console.log('infinite scroll:', JSON.stringify(scrolled), '→', JSON.stringify(afterScroll));
if (afterScroll.cards <= scrolled.cards) {
  throw new Error(
    'the infinite-scroll sentinel never loaded the next page: ' +
      `${JSON.stringify(scrolled)} → ${JSON.stringify(afterScroll)}. ` +
      'The capture would not be comparable, so it is not written.',
  );
}

await shot('07-hide-reposts', () => act(`
  const b = [...sec().querySelectorAll('button')].find((x) => /含转发|仅原创/.test((x.textContent || '').trim()));
  if (!b) throw new Error('no repost toggle');
  b.click(); return true;`));
await shot('08-hide-text-only', () => act(`
  const b = [...sec().querySelectorAll('button')].find((x) => /含纯文字|仅图文/.test((x.textContent || '').trim()));
  if (!b) throw new Error('no text-only toggle');
  b.click(); return true;`));
await shot('09-toggles-off', () => act(`
  ['含转发|仅原创', '含纯文字|仅图文'].forEach((pat) => {
    const b = [...sec().querySelectorAll('button')].find((x) => new RegExp(pat).test((x.textContent || '').trim()));
    if (b) b.click();
  });
  return true;`));

// Drag a platform row onto another and check BOTH the DOM order and the persisted
// setting. The extraction moved this arithmetic into a composable; a drop handler
// that no longer reorders anything is exactly the failure this catches.
const dragResult = await evaluate(`(async () => { ${PRELUDE}
  const rows = [...sec().querySelectorAll('[draggable="true"]')];
  if (rows.length < 2) return { error: 'need two draggable platform rows', found: rows.length };
  const label = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24);
  const namesBefore = rows.map(label);
  const dt = new DataTransfer();
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  fire(rows[1], 'dragstart');
  fire(rows[0], 'dragover');
  fire(rows[0], 'drop');
  fire(rows[1], 'dragend');
  await new Promise((r) => setTimeout(r, 600));
  const after = [...sec().querySelectorAll('[draggable="true"]')].map(label);
  return { namesBefore, after };
})()`);
await shot('10-platform-reordered');
console.log('drag:', JSON.stringify(dragResult));
if (dragResult.error) throw new Error('the drag step could not run: ' + JSON.stringify(dragResult));
if (JSON.stringify(dragResult.namesBefore) === JSON.stringify(dragResult.after)) {
  throw new Error('the drag gesture did not reorder the platform rows: ' + JSON.stringify(dragResult));
}

const persisted = await evaluate(`(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('CreatorFeedHubDB'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const settings = await new Promise((res, rej) => { const q = db.transaction('settings', 'readonly').objectStore('settings').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close();
  return JSON.stringify(settings.map((s) => s.value?.platformOrder ?? null));
})()`);
console.log('persisted platformOrder:', persisted);
if (!/"bilibili"/.test(persisted)) {
  console.log('   NOTE: platformOrder was not found in settings — the reorder may not have persisted.');
}

fs.writeFileSync(OUT, JSON.stringify(shots, null, 2));
console.log('captured', Object.keys(shots).length, 'shots →', OUT);

await send('Browser.close').catch(() => {});
await sleep(500);
child.kill('SIGKILL');
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
process.exit(0);
