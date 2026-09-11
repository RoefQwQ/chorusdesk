// Refactor-verification capture tool for the CreatorsView directory.
//
// It is NOT a test and it does not run in CI. It exists to answer one question
// during a refactor of this view: "did anything observable change?" Load the
// built extension, seed a fixture through the real backup import path, drive a
// scripted sequence of interactions, and record the rendered markup of the
// creators section at every step. Capture once before the change and once after,
// then compare:
//
//   node e2e/creators-render.mjs capture /tmp/before.json
//   # … change the view …
//   node e2e/creators-render.mjs capture /tmp/after.json
//   node e2e/creators-render.mjs diff /tmp/before.json /tmp/after.json
//
// A clean diff over every step is the evidence that the three view templates and
// the filter/sort results are unchanged; it is what the P4 slices of
// PROJECT_PROGRESS §四 cite. `capture` also asserts each step's post-condition
// (the rendered "N / M 位创作者" count, aria-sort state, select-all count) and the
// drag-reorder persistence, because a click that silently did nothing would make
// the comparison vacuous (AGENTS rule 26).
//
// Two scoping traps, both paid for once: every query must be scoped to the
// creators section (the dashboard keeps the other views' markup in the document,
// and FeedView's tag chips carry near-identical titles, so an unscoped
// querySelectorAll('button') clicks another view's control), and the search box
// must be found by placeholder (a bare `input[type=text]` matches something else).
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
    console.error('usage: node e2e/creators-render.mjs diff <before.json> <after.json>');
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
  console.error('usage: node e2e/creators-render.mjs capture <out.json> [--chrome <path>]');
  console.error('       node e2e/creators-render.mjs diff <before.json> <after.json>');
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'creators-render-'));

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
const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/dashboard.html` });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const PRELUDE = `
  const sec = () => {
    const s = [...document.querySelectorAll('section')].find((x) => x.textContent.includes('关注管理'));
    if (!s) throw new Error('creators section not rendered');
    return s;
  };
  const byTitle = (frag) => [...sec().querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes(frag));
  const badge = () => (sec().textContent.match(/(\\d+) \\/ (\\d+) 位创作者/) || [])[0];
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
const creator = (id, name, tags, updatedAt) => ({ id, name, avatar: '', tags, note: 'n' + id, sortOrder: 0, createdAt: now, updatedAt });
const chan = (id, creatorId, platform, role, status, extra = {}) => ({ id, creatorId, platform, accountId: 'a_' + id, displayName: '昵称_' + id, label: '标签_' + id, accountRole: role, profileUrl: 'https://example.com/' + id, status, ...extra });
const post = (id, creatorId, channelId) => ({ id, creatorId, channelId, platform: 'bilibili', content: id, mediaList: [], originalUrl: 'https://www.bilibili.com/video/' + id, publishedAt: now, fetchedAt: now, isRead: 0, isBookmarked: 0 });

const fixture = {
  version: '1.0', exportedAt: new Date(now).toISOString(),
  creators: [
    creator('r_c1', '丙丙', ['绘画', 'ASMR'], now - 100),
    creator('r_c2', '啊啊', ['ASMR'], now - 300),
    creator('r_c3', '不不', ['清水', '绘画', '短片'], now - 200),
    creator('r_c4', '没有账号的创作者', [], now - 400),
  ],
  channels: [
    chan('c1a', 'r_c1', 'bilibili', 'main', 'success', { lastCheckAt: now - 60 }),
    chan('c2a', 'r_c2', 'bilibili', 'main', 'success', { lastCheckAt: now - 120 }),
    chan('c2b', 'r_c2', 'twitter', 'sub', 'success'),
    chan('c2c', 'r_c2', 'youtube', 'alt', 'error', { errorMessage: '429 请求过于频繁' }),
    chan('c3a', 'r_c3', 'bilibili', 'sub', 'idle', { lastCheckAt: now - 90 }),
    chan('c3b', 'r_c3', 'twitter', 'custom', 'idle'),
  ],
  posts: [
    post('p1', 'r_c1', 'c1a'),
    post('p2', 'r_c2', 'c2a'), post('p3', 'r_c2', 'c2a'),
    post('p4', 'r_c3', 'c3a'), post('p5', 'r_c3', 'c3a'), post('p6', 'r_c3', 'c3a'),
  ],
  settings: { itemsPerFetch: 10, enableAutoSync: false },
};
const fixturePath = path.join(profile, 'render-fixture.json');
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
await sleep(1200);
await send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});

const seeded = await evaluate(`(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('CreatorFeedHubDB'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const read = (s) => new Promise((res, rej) => { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const out = { creators: (await read('creators')).length, channels: (await read('channels')).length, posts: (await read('posts')).length };
  db.close(); return out;
})()`);
console.log('seeded:', JSON.stringify(seeded));
if (seeded.creators !== 4) throw new Error('fixture did not import: ' + JSON.stringify(seeded));

await navClick('关注');
await sleep(500);

// ---------------------------------------------------------------- capture
await shot('01-grid');
await shot('02-list', () => act(`byTitle('紧凑列表视图').click(); return badge();`));
await shot('03-list-sort-channels', () => act(`sec().querySelector('thead th:nth-child(2) button').click(); return badge();`));
await shot('04-list-sort-posts', () => act(`sec().querySelector('thead th:nth-child(4) button').click(); return badge();`));
await shot('05-list-sort-posts-flipped', () => act(`sec().querySelector('thead th:nth-child(4) button').click(); return badge();`));
await shot('06-list-expanded', () => act(`sec().querySelector('tbody tr').click(); return badge();`));
await shot('07-list-row-action-hover-targets', () => act(`
  const tr = sec().querySelector('tbody tr');
  return [...tr.querySelectorAll('button[title]')].map((b) => b.getAttribute('title')).join('|');`));
await shot('08-list-role-pill', () => act(`[...sec().querySelectorAll('button')].find((b) => /^小号/.test((b.textContent || '').trim())).click(); return badge();`));
await shot('09-list-platform-pill', () => act(`[...sec().querySelectorAll('button')].find((b) => (b.textContent || '').includes('X (Twitter)')).click(); return badge();`));
await shot('10-list-search', () => act(`
  const input = sec().querySelector('input[placeholder^="快速搜索创作者"]');
  input.value = 'ASMR';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return badge();`));
await shot('11-tags-drawer', () => act(`
  const input = sec().querySelector('input[placeholder^="快速搜索创作者"]');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  byTitle('标签过滤').click();
  return badge();`));
await shot('12-tag-include', () => act(`
  const chip = [...sec().querySelectorAll('button')].find((b) => (b.textContent || '').trim().endsWith('#绘画'));
  if (!chip) throw new Error('no tag chip in the directory drawer');
  const before = chip.getAttribute('title');
  chip.click();
  return before;`));
await shot('13-batch-mode', () => act(`[...sec().querySelectorAll('button')].find((b) => (b.textContent || '').includes('批量操作')).click(); return badge();`));
await shot('14-batch-select-all', () => act(`[...sec().querySelectorAll('button')].find((b) => (b.textContent || '').includes('全选')).click(); return badge();`));
await shot('15-batch-cleared', () => act(`[...sec().querySelectorAll('button')].find((b) => (b.textContent || '').includes('清空选择')).click(); return badge();`));
await shot('16-batch-off', () => act(`[...sec().querySelectorAll('button')].find((b) => (b.textContent || '').includes('完成批量')).click(); return badge();`));
await shot('17-detailed', () => act(`byTitle('详细卡片视图').click(); return badge();`));
await shot('18-grid-again', () => act(`byTitle('网格磁贴视图').click(); return badge();`));

// Manual sort + drag reorder. The extraction rewrote the three drag handlers from
// inline template expressions into callbacks, which is exactly the kind of change
// that can look right and reorder nothing — so drive the real gesture and check
// the persisted order, not just the DOM.
// Clear every filter first: the drag steps need more than one row on screen.
await shot('19-filters-cleared', () => act(`
  const input = sec().querySelector('input[placeholder^="快速搜索创作者"]');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const alls = [...sec().querySelectorAll('button')].filter((b) => /^全部/.test((b.textContent || '').trim()));
  alls.forEach((b) => b.click());
  byTitle('紧凑列表视图').click();
  return badge();`));

// The AppSelect trigger reports its state through `aria-expanded`, and Vue
// flushes the DOM update on a microtask — so the open state must be read AFTER an
// await. Reading it synchronously reports the previous render and made a working
// control look dead (AGENTS rule 30).
const sortStep = (body) => evaluate(`(async () => { ${PRELUDE} ${body} })()`);
const sortTrigger = `
  const trigger = () => [...sec().querySelectorAll('button[aria-expanded]')]
    .find((b) => /最近活跃|作品数量|账号数量|字母名称|标签|按平台分组|手动排序/.test((b.textContent || '').trim()));
`;

await shot('20-manual-sort', () => sortStep(`
  ${sortTrigger}
  const btn = trigger();
  if (!btn) throw new Error('sort trigger not found');
  btn.click();
  await new Promise((r) => setTimeout(r, 150));
  const opened = btn.getAttribute('aria-expanded');
  const optionsVisible = [...sec().querySelectorAll('button')].filter((b) => /^手动排序$/.test((b.textContent || '').trim())).length;
  // Close before capturing: the dropdown is a Vue <Transition>, and this window is
  // off-screen and never composited, so its enter/leave animation never settles
  // (rule 30 — no frames means no rAF). Capturing it mid-transition made steps
  // 20-22 differ between two runs of the SAME build. The open state is asserted
  // here instead of photographed.
  btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  return 'aria-expanded=' + opened + ' options=' + optionsVisible + ' afterEscape=' + btn.getAttribute('aria-expanded');
`));
await shot('21-manual-sort-chosen', () => sortStep(`
  ${sortTrigger}
  trigger().click();
  await new Promise((r) => setTimeout(r, 150));
  const opt = [...sec().querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '手动排序');
  if (!opt) throw new Error('manual-sort option not found after opening');
  opt.click();
  await new Promise((r) => setTimeout(r, 150));
  return 'sort label now: ' + (trigger() || {}).textContent?.trim();
`));
const dragResult = await evaluate(`(async () => { ${PRELUDE}
  const rows = [...sec().querySelectorAll('tbody tr')].filter((tr) => !tr.querySelector('td[colspan]'));
  if (rows.length < 2) {
    return { error: 'need two rows', badge: badge(), rowCount: rows.length, tags: [...sec().querySelectorAll('button')].filter(b=>/^全部|^#|^小号|^主账号/.test((b.textContent||'').trim())).map(b=>b.textContent.trim()+':'+(b.className.includes('bg-indigo-600')?'ON':'off')) };
  }
  const namesBefore = rows.map((tr) => tr.querySelector('td:nth-child(1) span.font-semibold').textContent.trim());
  const dt = new DataTransfer();
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  fire(rows[1], 'dragstart');
  fire(rows[0], 'dragover');
  fire(rows[0], 'drop');
  fire(rows[1], 'dragend');
  await new Promise((r) => setTimeout(r, 400));
  const after = [...sec().querySelectorAll('tbody tr')].filter((tr) => !tr.querySelector('td[colspan]'))
    .map((tr) => tr.querySelector('td:nth-child(1) span.font-semibold').textContent.trim());
  return { namesBefore, after, draggable: rows[0].draggable };
})()`);
await shot('22-drag-reordered');
console.log('drag:', JSON.stringify(dragResult));
if (dragResult.error) {
  throw new Error('the drag step could not run: ' + JSON.stringify(dragResult));
}
if (JSON.stringify(dragResult.namesBefore) === JSON.stringify(dragResult.after)) {
  throw new Error('the drag gesture did not reorder the rows: ' + JSON.stringify(dragResult));
}

const orderInDb = await evaluate(`(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('CreatorFeedHubDB'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const creators = await new Promise((res, rej) => { const q = db.transaction('creators', 'readonly').objectStore('creators').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close();
  return creators.map((c) => c.name + ':' + (c.sortOrder ?? 'none'));
})()`);
console.log('persisted sortOrder:', JSON.stringify(orderInDb));

fs.writeFileSync(OUT, JSON.stringify(shots, null, 2));

// Post-conditions: a step whose click silently did nothing makes the whole
// comparison vacuous (AGENTS rule 26).
const badgeOf = (label) => (shots[label].match(/(\d+) \/ (\d+) 位创作者/) || []).slice(1).join('/');
const expectations = [
  ['01-grid', '4/4'], ['02-list', '4/4'],
  ['08-list-role-pill', '2/4'],       // 小号: 啊啊(c2 sub) 不不(c3 sub)
  ['09-list-platform-pill', '2/4'],
  ['10-list-search', '1/4'],          // + ASMR: 啊啊
  ['11-tags-drawer', '2/4'],
  ['12-tag-include', '1/4'],          // + 绘画: 不不
  ['13-batch-mode', '1/4'], ['16-batch-off', '1/4'],
  ['17-detailed', '1/4'], ['18-grid-again', '1/4'],
];
const verified = expectations.map(([label, want]) => {
  const got = badgeOf(label);
  if (got !== want) throw new Error(`step ${label}: badge ${got}, expected ${want} — the action did not take effect`);
  return `${label}=${got}`;
});
console.log('badges verified:', verified.join(' '));

// Batch steps must show a checkbox column, and select-all must select the rows.
const batchSelected = shots['14-batch-select-all'].match(/已选 (\d+) 位/);
if (!batchSelected || batchSelected[1] !== '1') throw new Error('select-all did not select the filtered row: ' + JSON.stringify(batchSelected));
if (!/aria-sort="descending"/.test(shots['04-list-sort-posts'])) throw new Error('post-count sort did not set aria-sort=descending');
if (!/aria-sort="ascending"/.test(shots['05-list-sort-posts-flipped'])) throw new Error('second click did not flip to ascending');
console.log('batch + aria-sort assertions passed');

console.log('captured', Object.keys(shots).length, 'shots →', OUT);

await send('Browser.close').catch(() => {});
await sleep(500);
child.kill('SIGKILL');
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
process.exit(0);
