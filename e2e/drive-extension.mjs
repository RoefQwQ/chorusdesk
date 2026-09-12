// Drive the REAL extension flow in the browser: open the dashboard,
// trigger a douyin history dig via the app's own services, capture results.
// Usage: node e2e/drive-extension.mjs <dashboard-ws-url> <secUid>
const wsUrl = process.argv[2];

const ws = await import('ws');
const socket = new ws.WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function evalInPage(expression) {
  return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
}

socket.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

socket.on('open', async () => {
  try {
    await send('Runtime.enable');

    // 1. What channels exist and their cursor state (via the app's own db).
    await evalInPage(`(async () => {
      const dbMod = await import('/chunks/main-V1p6wrdZ.js').catch(() => null);
      return { modLoaded: !!dbMod };
    })()`);

    // The dashboard page exposes no module import path; instead query IndexedDB directly.
    const channels = await evalInPage(`(async () => {
      const dbs = await indexedDB.databases();
      const names = dbs.map(d => d.name);
      return names;
    })()`);
    console.log('IndexedDB databases:', JSON.stringify(channels.result.value));

    // 2. Read the douyin channel rows via raw IndexedDB.
    const douyinChannel = await evalInPage(`(async () => {
      const dbName = (await indexedDB.databases()).map(d => d.name).find(n => /chorus|creatorfeed|feed/i.test(n));
      if (!dbName) return { error: 'no db' };
      return await new Promise((resolve) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('channels')) { resolve({ error: 'no channels store', stores: [...db.objectStoreNames] }); return; }
          const tx = db.transaction('channels', 'readonly');
          const store = tx.objectStore('channels');
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            const chans = getAll.result.filter(c => c.platform === 'douyin');
            resolve(chans.map(c => ({
              id: c.id, displayName: c.displayName, accountId: (c.accountId||'').slice(0,20),
              nextCursor: c.nextCursor, status: c.status, errorMessage: c.errorMessage,
              lastCheckAt: c.lastCheckAt ? new Date(c.lastCheckAt).toISOString() : null,
            })));
          };
        };
      });
    })()`);
    console.log('DOUYIN CHANNELS:', JSON.stringify(douyinChannel.result.value, null, 2));

    // 3. Count douyin posts per channel.
    const postCount = await evalInPage(`(async () => {
      const dbName = (await indexedDB.databases()).map(d => d.name).find(n => /chorus|creatorfeed|feed/i.test(n));
      if (!dbName) return { error: 'no db' };
      return await new Promise((resolve) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('posts', 'readonly');
          const idx = tx.objectStore('posts').index('platform');
          const req2 = idx.getAll('douyin');
          req2.onsuccess = () => {
            const posts = req2.result;
            const byChannel = {};
            for (const p of posts) {
              byChannel[p.channelId] = byChannel[p.channelId] || [];
              byChannel[p.channelId].push({ id: p.id, at: new Date(p.publishedAt).toISOString().slice(0,10) });
            }
            for (const k of byChannel) byChannel[k].sort((a,b) => b.at.localeCompare(a.at));
            resolve(byChannel);
          };
        };
      });
    })()`);
    console.log('DOUYIN POSTS BY CHANNEL:', JSON.stringify(postCount.result.value, null, 2));

    socket.close();
    process.exit(0);
  } catch (err) {
    console.error('drive failed:', err);
    process.exit(1);
  }
});

socket.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
