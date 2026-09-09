// CDP probe of a real douyin.com creator page.
// Usage: node e2e/douyin-probe.mjs <ws-url> [out.json]
// Collects: login state, tab-count candidates, scroll containers, grid growth.
const wsUrl = process.argv[2];
const outPath = process.argv[3] || 'e2e/probe-result.json';

const ws = await import('ws');
const socket = new ws.WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();
const replies = [];
const consoleLogs = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function runtimeEval(expression, awaitPromise = false) {
  return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
}

socket.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLogs.push(`[${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
  }
});

socket.on('open', async () => {
  try {
    await send('Runtime.enable');
    const report = { startedAt: new Date().toISOString(), steps: {} };

    // 1. Login state: douyin renders the login panel differently when logged in.
    const login = await runtimeEval(`(() => {
      const loginBtn = document.querySelector('[data-e2e="login"], .login-btn, [class*="login"]');
      const avatar = document.querySelector('[data-e2e="user-avatar"], .avatar, [class*="avatar"]');
      return {
        hasLoginButton: !!loginBtn,
        loginButtonText: loginBtn ? (loginBtn.innerText || '').slice(0, 40) : null,
        cookieLen: document.cookie ? document.cookie.length : 0,
      };
    })()`);
    report.steps.login = login.result.value;

    // 2. All elements carrying a work-count shape near the profile header.
    const counts = await runtimeEval(`(() => {
      const out = [];
      // data-e2e variants
      for (const el of document.querySelectorAll('[data-e2e]')) {
        const e2e = el.getAttribute('data-e2e');
        if (/count|num|tab/i.test(e2e)) {
          out.push({ via: 'data-e2e', key: e2e, text: (el.innerText || '').slice(0, 40) });
        }
      }
      // The profile tab strip: 作品 <n> / 喜欢 <n> etc.
      const tabs = document.querySelectorAll('[data-e2e="user-tab-count"]');
      for (const t of tabs) out.push({ via: 'tab-count', text: (t.innerText || '').slice(0, 40), html: t.outerHTML.slice(0, 200) });
      return out;
    })()`);
    report.steps.countCandidates = counts.result.value;

    // 3. The grid and its scroll containers.
    const gridInfo = await runtimeEval(`(() => {
      const grid = document.querySelector('[data-e2e="user-post-list"]');
      if (!grid) return { found: false };
      const cards = grid.querySelectorAll('li').length;
      const hrefs = grid.querySelectorAll('a[href*="/video/"], a[href*="/note/"]').length;
      const scrollers = [];
      let node = grid;
      while (node && node !== document.body) {
        if (node.scrollHeight > node.clientHeight + 20) {
          scrollers.push({
            tag: node.tagName, cls: (node.className || '').toString().slice(0, 80),
            scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
          });
        }
        node = node.parentElement;
      }
      return { found: true, cards, hrefs, scrollers };
    })()`);
    report.steps.grid = gridInfo.result.value;

    // 4. Count before/after driving the scrollers, exactly like the collector.
    const growth = await runtimeEval(`(async () => {
      const countWorks = () => {
        const grid = document.querySelector('[data-e2e="user-post-list"]');
        if (!grid) return 0;
        const hrefs = Array.from(grid.querySelectorAll('a[href*="/video/"], a[href*="/note/"]'))
          .map(a => a.getAttribute('href') || '')
          .filter(h => /\\/(?:video|note)\\/\\d{15,25}/.test(h));
        return new Set(hrefs).size;
      };
      const before = countWorks();
      for (let round = 0; round < 8; round++) {
        const grid = document.querySelector('[data-e2e="user-post-list"]');
        if (grid) {
          const cards = grid.querySelectorAll('li');
          if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'end' });
          let node = grid;
          while (node) {
            if (node.scrollHeight > node.clientHeight + 20) node.scrollTop = node.scrollHeight;
            node = node.parentElement;
          }
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(r => setTimeout(r, 900));
      }
      const after = countWorks();
      // Also read the stated total now, post-scroll.
      let stated = null;
      const tc = document.querySelector('[data-e2e="user-tab-count"]');
      if (tc && /^\\d+$/.test((tc.innerText || '').trim())) stated = Number(tc.innerText.trim());
      return { before, after, statedAfterScroll: stated };
    })()`, true);
    report.steps.gridGrowth = growth.result.value;

    // 5. Re-read counts after the scroll settled.
    const countsAfter = await runtimeEval(`(() => {
      const out = [];
      for (const t of document.querySelectorAll('[data-e2e="user-tab-count"]')) {
        out.push({ text: (t.innerText || '').slice(0, 40) });
      }
      return out;
    })()`);
    report.steps.countsAfterScroll = countsAfter.result.value;

    report.consoleLogs = consoleLogs.slice(0, 30);
    const fs = await import('node:fs');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log('PROBE RESULT:\n' + JSON.stringify(report, null, 2));
    socket.close();
    process.exit(0);
  } catch (err) {
    console.error('probe failed:', err);
    process.exit(1);
  }
});

socket.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
