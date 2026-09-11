// Smoke test for the recycle-bin lifecycle in a REAL extension host.
//
// Why this exists: the recycle-bin composable was rewired from seven direct
// `postRepository` imports to `postService` methods (AGENTS rule 8). Delegation
// is exactly the change a type-checker cannot validate - a well-typed call to the
// WRONG service method compiles fine and deletes the wrong thing. So this drives
// every one of the seven through the real UI and asserts the observable outcome
// in IndexedDB, not the wiring.
//
//   node e2e/recycle-bin-smoke.mjs
//
// Self-contained: own profile under the system temp dir, deleted on exit. Never
// touches a running browser (AGENTS rule 25). Requires `npm run build` first.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve('.output/chrome-mv3');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-recycle-'));

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
const dialogs = [];
let id = 0;
let sessionId;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(`${m.method}: ${m.error.message}`)) : p.resolve(m.result);
    return;
  }
  // `confirm()` blocks the renderer AND CDP. Answer immediately, always accept.
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message.split('\n')[0]);
    ws.send(JSON.stringify({
      id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true }, sessionId: m.sessionId,
    }));
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { id: extId } = await send('Extensions.loadUnpacked', { path: EXT });
const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/dashboard.html` });
({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// In-page helpers. All queries go through the dashboard nav + the recycle-bin card,
// which have stable ids/titles.
const PRELUDE = `
  const nav = async (t) => {
    const b = [...document.querySelectorAll('nav button')].find((x) => (x.textContent || '').includes(t));
    if (!b) throw new Error('no nav ' + t);
    b.click();
    await new Promise((r) => setTimeout(r, 350));
    return true;
  };
  const bin = () => document.getElementById('recycle-bin-section');
  const binCount = () => {
    const m = bin().textContent.match(/(\\d+) 条记录/);
    return m ? Number(m[1]) : -1;
  };
  const byTitle = (frag) => [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes(frag));
  // Exact match, and only among buttons that are actually rendered: the dashboard
  // keeps the other tabs' markup in the document, so a loose substring search can
  // hit a hidden control on a tab the user is not looking at (this happened while
  // writing this probe: '删除' matched the settings tab's 彻底删除, which is
  // display:none, and the click silently did nothing).
  const byExactTitle = (t) => [...document.querySelectorAll('button')]
    .filter((b) => b.getAttribute('title') === t && b.offsetParent !== null)[0];
  const byText = (frag) => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(frag));
  const dbCounts = async () => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('CreatorFeedHubDB'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const read = (s) => new Promise((res, rej) => { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const out = { posts: (await read('posts')).length, tombstones: (await read('deletedPostIds')).length };
    db.close();
    return out;
  };
`;
const act = (body) => ev(`(async () => { ${PRELUDE} ${body} })()`);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${ok ? '' : `  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

// ---- seed: 3 posts through the real import path ----
const now = Date.UTC(2026, 8, 11, 12, 0, 0);
const post = (n) => ({
  id: `smoke_post_${n}`, creatorId: 'smoke_c', channelId: 'bilibili:smoke', platform: 'bilibili',
  channelLabel: '主账号', title: `冒烟样例 ${n}`, content: `正文 ${n}`, mediaList: [],
  originalUrl: `https://www.bilibili.com/video/smoke${n}`, publishedAt: now - n * 1000,
  fetchedAt: now, isRead: 0, isBookmarked: 0,
});
const fixture = {
  version: '1.0', exportedAt: new Date(now).toISOString(),
  creators: [{ id: 'smoke_c', name: '冒烟博主', avatar: '', tags: ['冒烟'], createdAt: now, updatedAt: now }],
  channels: [{ id: 'bilibili:smoke', creatorId: 'smoke_c', platform: 'bilibili', accountId: 'smoke', displayName: '冒烟账号', accountRole: 'main', profileUrl: 'https://space.bilibili.com/smoke', status: 'idle' }],
  posts: [post(1), post(2), post(3)],
  settings: { itemsPerFetch: 10, enableAutoSync: false },
};
const fixturePath = path.join(profile, 'fixture.json');
fs.writeFileSync(fixturePath, JSON.stringify(fixture));

await sleep(1400);
await act(`await nav('设置'); return true;`);
{
  const { root } = await send('DOM.getDocument', { depth: 1 }, sessionId);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept=".json"]' }, sessionId);
  if (!nodeId) throw new Error('import input not found');
  await send('DOM.setFileInputFiles', { nodeId, files: [fixturePath] }, sessionId);
}
await sleep(1200);
await act(`await nav('设置'); return true;`);
const seeded = await act(`return await dbCounts();`);
console.log('seeded:', JSON.stringify(seeded));
check('seed imported 3 posts, 0 tombstones', seeded, { posts: 3, tombstones: 0 });

// ---- 1. delete → tombstone (deleteToRecycleBin) ----
await act(`await nav('动态'); return true;`);
await sleep(400);
const deleted = await act(`
  const btn = byExactTitle('删除动态');
  if (!btn) throw new Error('no delete control on the post card; visible titles: ' + [...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null).map(b=>b.getAttribute('title')).filter(Boolean).join(' | '));
  btn.click();
  await new Promise((r) => setTimeout(r, 500));
  return await dbCounts();`);
console.log('after delete:', JSON.stringify(deleted), '| dialogs:', JSON.stringify(dialogs));
check('delete moved one post to the tombstone store', deleted, { posts: 2, tombstones: 1 });

// ---- 2. the recycle-bin card reflects it (recycleBinCount + recycleBinRecords) ----
await act(`await nav('设置'); return true;`);
const shown = await act(`return { badge: binCount(), rows: bin().querySelectorAll('[title="立即将此动态定向找回并还原到动态流"]').length };`);
console.log('recycle bin card:', JSON.stringify(shown));
check('settings badge and list both show 1 record', shown, { badge: 1, rows: 1 });

// ---- 3. restore single (restoreFromRecycleBin) ----
const restored = await act(`
  (byExactTitle('立即将此动态定向找回并还原到动态流') || byTitle('立即将此动态定向找回并还原到动态流')).click();
  await new Promise((r) => setTimeout(r, 900));
  return await dbCounts();`);
console.log('after single restore:', JSON.stringify(restored));
check('single restore put the post back and cleared the tombstone', restored, { posts: 3, tombstones: 0 });

// ---- 4. delete again, then permanently delete (permanentlyDelete) ----
await act(`await nav('动态'); return true;`);
await sleep(400);
await act(`byExactTitle('删除动态').click(); await new Promise((r) => setTimeout(r, 500)); return true;`);
await act(`await nav('设置'); return true;`);
const perm = await act(`
  const del = byExactTitle('彻底删除'); if (!del) throw new Error('no permanent-delete control'); del.click();
  await new Promise((r) => setTimeout(r, 700));
  return await dbCounts();`);
console.log('after permanent delete:', JSON.stringify(perm));
check('permanent delete leaves the tombstone gone and no post back', perm, { posts: 2, tombstones: 0 });

// ---- 5. delete twice, then "restore all" (restoreAllFromRecycleBin) ----
await act(`await nav('动态'); return true;`);
await sleep(400);
await act(`byExactTitle('删除动态').click(); await new Promise((r) => setTimeout(r, 600)); return true;`);
await act(`byExactTitle('删除动态').click(); await new Promise((r) => setTimeout(r, 600)); return true;`);
await act(`await nav('设置'); return true;`);
const beforeAll = await act(`return await dbCounts();`);
console.log('before restore-all:', JSON.stringify(beforeAll));
const allBack = await act(`
  byText('全部找回并还原').click();
  await new Promise((r) => setTimeout(r, 1200));
  return await dbCounts();`);
console.log('after restore-all:', JSON.stringify(allBack));
// Expected 2, not 3: step 4 permanently deleted one post, so only 2 exist by now.
// The invariant is "every tombstone came back", i.e. posts == beforeAll.tombstones.
check('restore-all put every tombstoned post back', allBack, { posts: beforeAll.tombstones, tombstones: 0 });

// ---- 6. delete twice, then empty the bin (emptyRecycleBin) ----
await act(`await nav('动态'); return true;`);
await sleep(400);
await act(`byExactTitle('删除动态').click(); await new Promise((r) => setTimeout(r, 600)); return true;`);
await act(`byExactTitle('删除动态').click(); await new Promise((r) => setTimeout(r, 600)); return true;`);
await act(`await nav('设置'); return true;`);
const beforeEmpty = await act(`return await dbCounts();`);
console.log('before empty bin:', JSON.stringify(beforeEmpty));
const emptied = await act(`
  byText('清空回收站').click();
  await new Promise((r) => setTimeout(r, 800));
  return await dbCounts();`);
console.log('after empty bin:', JSON.stringify(emptied));
// Differencing against the reading just before: emptying must drop every tombstone
// and resurrect nothing (posts unchanged), whatever the absolute count happens to be.
check('empty bin drops the tombstones and resurrects nothing', emptied, { posts: beforeEmpty.posts, tombstones: 0 });
check('empty bin had tombstones to drop', beforeEmpty.tombstones > 0, true);

console.log('');
console.log(`RECYCLE-BIN SMOKE: ${failures ? 'FAILED' : 'PASSED'} — ${failures} failed assertion(s)`);
console.log('dialogs answered:', dialogs.length);

await send('Browser.close').catch(() => {});
await sleep(500);
child.kill('SIGKILL');
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
process.exit(failures ? 1 : 0);
