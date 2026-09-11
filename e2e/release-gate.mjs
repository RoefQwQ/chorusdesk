// Release gate: load the BUILT extension into its own Chrome and drive the three
// flows that only exist in a real extension host. Run by .github/workflows/
// release.yml before a release is published; this is the automation of the
// manual probes performed on 2026-09-11 (AGENTS.md rule 28, PROJECT_PROGRESS
// §四.P7 补记).
//
// What it exercises, and why each one is here:
//
//   1. backup export   — a real click on 「下载 JSON 备份」, captured as a real
//                        download. Proves the Blob/anchor path actually yields a
//                        file, which no unit test can.
//   2. backup import   — the exported file is fed back through the REAL file
//                        input (`DOM.setFileInputFiles`), so parseBackup's
//                        validation and restoreBackup's transaction run for real.
//                        Import→export is asserted lossless against the fixture.
//   3. alarm survival  — enabling auto-sync creates the alarm, then opening the
//                        popup and restarting the service worker must NOT reset
//                        its scheduledTime. This is the regression AGENTS rule 7
//                        describes: an unconditional `alarms.create` on every SW
//                        wake meant the 30-minute timer never fired.
//
// Constraints that shaped it (all measured, all in AGENTS.md):
//   - `--load-extension` is ignored by regular Chrome; CDP `Extensions.loadUnpacked`
//     works only with `--enable-unsafe-extension-debugging` (rule 28).
//   - A native `alert()` blocks the renderer and CDP with it, and the import
//     success path calls one. The Page domain is enabled and dialogs are
//     auto-accepted on every page session for that reason.
//   - It must never touch the user's browser: its own profile under the system
//     temp dir, its own download dir, off-screen window, deleted on exit (rule 25).
//
// Usage:
//   node e2e/release-gate.mjs [--extension <dir>] [--chrome <path>] [--keep-profile]
//                             [--timeout <ms>] [--verbose]
//
// Exit code 0 only when every check passed. Node >= 22 (global WebSocket — no
// dependency, which is what makes this runnable in CI without an install step).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
if (flag('help')) {
  console.log(
    [
      'node e2e/release-gate.mjs [options]',
      '',
      '  --extension <dir>   built extension dir (default .output/chrome-mv3)',
      '  --chrome <path>     Chrome binary (default: CHROME_PATH, then the usual install paths)',
      '  --timeout <ms>      whole-run watchdog, default 240000',
      '  --keep-profile      keep the throwaway profile and print its path',
      '  --verbose           also print page console output',
    ].join('\n'),
  );
  process.exit(0);
}

const EXT_DIR = path.resolve(REPO, String(flag('extension') ?? '.output/chrome-mv3'));

/**
 * Is this a hosted CI runner? Asked precisely, because the loose signal is wrong.
 *
 * The window handling below keyed off `process.env.CI`, and that was a real bug:
 * `CI=true` is set in ordinary developer environments too (this one included), so
 * "skip the off-screen position and the minimize when CI is set" meant the window
 * was never minimized and was placed at the DEFAULT position — i.e. opened in the
 * middle of the user's screen. The user reported seeing it twice; the second time
 * was caused by that guard.
 *
 * `GITHUB_ACTIONS` is set only on GitHub's runners, which is the actual question:
 * there is no user, and the window must stay on the (small) X screen because an
 * off-screen window under Xvfb receives no synthetic input.
 */
const ON_CI_RUNNER = Boolean(process.env.GITHUB_ACTIONS);
const RUN_TIMEOUT_MS = Number(flag('timeout') ?? 240_000);
const KEEP_PROFILE = flag('keep-profile') === true;
const VERBOSE = flag('verbose') === true;

const REQUEST_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 20_000;
const ALARM_NAME = 'creator-feed-auto-sync';
const ALARM_PERIOD_MINUTES = 30;
const BACKUP_FILE_RE = /^creator-feed-hub-backup-\d{4}-\d{2}-\d{2}\.json$/;

// ---------------------------------------------------------------- reporting

const steps = [];
let currentStep = null;

/**
 * Thrown by a step whose *capability* is missing on this host (as opposed to a
 * product failure). Recorded as `skip`, never as `pass`: a check that could not
 * run must not look like one that ran and succeeded.
 */
class Skipped extends Error {}

function out(line = '') {
  process.stdout.write(`${line}\n`);
}
function detail(line) {
  if (currentStep) currentStep.notes.push(line);
  if (VERBOSE) out(`        ${line}`);
}

/**
 * Run one check. Any dependency that did not pass blocks this one: a skipped
 * dependency means its data never existed, and letting dependents run on it
 * turns one failure into a cascade of TypeError-shaped ones. Steps that can work
 * without a neighbour's value therefore declare only the deps they truly need.
 */
async function step(name, deps, fn) {
  const blocked = deps.find((d) => steps.find((s) => s.name === d)?.status !== 'pass');
  const record = { name, status: 'pass', notes: [], error: undefined };
  if (blocked) {
    record.status = 'skip';
    record.error = `blocked by failed step: ${blocked}`;
    record.notes.push(record.error);
    steps.push(record);
    out(`  skip  ${name}  (blocked by ${blocked})`);
    return undefined;
  }
  currentStep = record;
  const started = Date.now();
  try {
    const value = await fn();
    record.ms = Date.now() - started;
    steps.push(record);
    currentStep = null;
    out(`  pass  ${name}  (${record.ms} ms)`);
    for (const n of record.notes) out(`        ${n}`);
    return value;
  } catch (err) {
    record.ms = Date.now() - started;
    record.status = err instanceof Skipped ? 'skip' : 'fail';
    record.error = err instanceof Error ? err.message : String(err);
    steps.push(record);
    currentStep = null;
    out(`  ${record.status === 'skip' ? 'skip' : 'FAIL'}  ${name}  (${record.ms} ms)`);
    for (const n of record.notes) out(`        ${n}`);
    out(`        → ${record.error}`);
    return undefined;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- CDP client

/**
 * One browser-level WebSocket, session-multiplexed. `sessionId` on the envelope
 * is what makes this possible: the service worker, a downloaded page and a
 * popup are all driven from a single socket, and no target has to be found by
 * scraping /json/list.
 */
class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Set();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.#pending.has(msg.id)) {
        const entry = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method) for (const handler of this.#handlers) handler(msg);
    });
    ws.addEventListener('close', () => {
      for (const entry of this.#pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed'));
      }
      this.#pending.clear();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP connect timeout: ${url}`));
      }, 15_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${url}`));
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      // Every request is bounded. A gate that hangs is worse than one that
      // fails: it burns the pipeline's timeout budget with no diagnosis.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  onEvent(handler) {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** A CDP target we can evaluate in and drive. */
class Target {
  constructor(cdp, sessionId, label) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.label = label;
    this.dialogs = [];
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  /** Enable the domains every page session needs; the SW target has no Page domain. */
  async init({ page = true } = {}) {
    await this.send('Runtime.enable');
    // Record page-side errors. Without this a JS exception in the app is
    // completely invisible: the symptom is only that some later probe never
    // becomes true, which reads like a UI bug rather than a thrown error.
    this.pageErrors = [];
    this.cdp.onEvent((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        const text = d.exception?.description ?? d.text ?? 'unknown exception';
        this.pageErrors.push(text);
        detail(`page exception: ${String(text).split('\n')[0]}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? a.type ?? '')
          .join(' ');
        this.pageErrors.push(text);
        detail(`page console.error: ${text}`);
      }
    });
    if (page) {
      await this.cdp.send('Page.enable', {}, this.sessionId);
      // The import success path calls alert(); an unanswered dialog blocks this
      // renderer AND every later evaluate on it. Answer it before that.
      this.cdp.onEvent((msg) => {
        if (msg.method !== 'Page.javascriptDialogOpening' || msg.sessionId !== this.sessionId) return;
        this.dialogs.push(`${msg.params.type}: ${msg.params.message}`);
        detail(`dialog #${this.dialogs.length} at +${Date.now() - startedAt}ms: ${msg.params.message}`);
        this.cdp
          .send('Page.handleJavaScriptDialog', { accept: true }, this.sessionId)
          .catch(() => {});
      });
    }
    return this;
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`${this.label}: evaluate threw: ${description}`);
    }
    return result.result.value;
  }

  /** Poll a probe until it returns a truthy value, or time out with its last error. */
  async wait(description, probe, { timeout = WAIT_TIMEOUT_MS, interval = 200 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        const value = await probe();
        if (value) return value;
        last = `probe returned ${JSON.stringify(value)}`;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${timeout}ms waiting for ${description} (${last})`);
      }
      await sleep(interval);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- Chrome

function findChrome() {
  const override = flag('chrome') ?? process.env.CHROME_PATH;
  if (override && typeof override === 'string') {
    assert(fs.existsSync(override), `Chrome not found at --chrome/CHROME_PATH: ${override}`);
    return override;
  }
  const candidates = {
    win32: [
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
  }[process.platform];
  assert(candidates, `unsupported platform: ${process.platform}; pass --chrome <path>`);
  const hit = candidates.find((c) => c && fs.existsSync(c));
  assert(
    hit,
    `Chrome not found. Tried:\n    ${candidates.join('\n    ')}\n  Pass --chrome <path> or set CHROME_PATH.`,
  );
  return hit;
}

/**
 * Launch the throwaway instance and connect to its browser-level WebSocket.
 * `--remote-debugging-port=0` lets Chrome pick a free port and write it to
 * `DevToolsActivePort`, which avoids colliding with anything already listening.
 */
async function launchChrome({ chromePath, profileDir }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    // The flag that decides whether Extensions.loadUnpacked exists at all.
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    // Containers and CI runners often mount a small /dev/shm, where Chrome's
    // renderer dies with a SIGBUS that looks like a hang. Harmless elsewhere.
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
    // Park the window out of the way ONLY when there is a user to disturb.
    //
    // This was unconditional, and on CI it was the actual cause of an
    // intermittent failure: Xvfb's default virtual screen is 1280x1024, so a
    // window at -2400,-2400 is entirely outside it, and synthetic input aimed at
    // that window is dropped — `Input.dispatchMouseEvent` reported success while
    // the page received nothing (mousedown=0 mouseup=0 click=0, run 34626248921).
    // Measured: failing runs took ~3.7-6.9 s to reach the first click and passed
    // or failed on the same commit; the runner has no user, so the negative
    // position bought nothing and cost a race.
    ...(ON_CI_RUNNER ? [] : ['--window-position=-2400,-2400']),
    'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) detail(`chrome exited early: code=${code} signal=${signal}`);
  });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(portFile)) {
    assert(child.exitCode === null, `Chrome exited before opening a debug port.\n${stderr.trim()}`);
    assert(Date.now() < deadline, `Chrome did not write DevToolsActivePort within 30s.\n${stderr.trim()}`);
    await sleep(150);
  }
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split('\n');
  assert(port && wsPath, `unreadable DevToolsActivePort: ${JSON.stringify({ port, wsPath })}`);
  const cdp = await Cdp.connect(`ws://127.0.0.1:${Number(port)}${wsPath.trim()}`);

  // MINIMIZE the window when a person is watching.
  //
  // `--window-position=-2400,-2400` does move the window there, but an off-screen
  // window is still on screen in every way that matters to the user: it shows in
  // the taskbar, it can be alt-tabbed to, and if the virtual desktop extends to
  // negative coordinates (a monitor placed left of the primary) it is simply ON a
  // real display. Minimizing is what actually keeps it out of the way.
  //
  // `hideWindow` is also called again later, because opening a target restores it.
  await hideWindow(cdp);
  return { child, cdp, chromeVersion: await versionOf(cdp) };
}

async function versionOf(cdp) {
  const { product } = await cdp.send('Browser.getVersion');
  return product;
}

async function killChrome(child, cdp) {
  try {
    await cdp.send('Browser.close');
  } catch {
    /* the process may already be gone */
  }
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(150);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await sleep(500);
  }
}

// ---------------------------------------------------------------- page helpers

/**
 * Mark an element found by `locator` (a function body string evaluated in the
 * page) with a temporary attribute, then click it with real mouse input.
 *
 * Real input rather than `element.click()`: the flows under test are user
 * gestures through Vue's event system, and the download path in particular is
 * sensitive to how the click arrives. The marker is what makes the element
 * addressable from Node at all — `DOM.querySelector` needs a selector, and the
 * buttons here are identified by their visible text.
 */
async function clickLocated(target, locator, label) {
  const MARK = 'data-e2e-gate-click';
  // Arm one-shot listeners on the target element so delivery is observable.
  // Without this, a click that never reached the page is indistinguishable from
  // an app that received it and did nothing — and on a machine with no real
  // display those are very different diagnoses.
  const marked = await target.eval(`(() => {
    document.querySelectorAll('[${MARK}]').forEach((el) => el.removeAttribute('${MARK}'));
    const el = (${locator})();
    if (!el) return null;
    el.setAttribute('${MARK}', '1');
    window.__gateClick = { down: 0, up: 0, click: 0 };
    const bump = (k) => () => { window.__gateClick[k] += 1; };
    el.addEventListener('mousedown', bump('down'), { once: true });
    el.addEventListener('mouseup', bump('up'), { once: true });
    el.addEventListener('click', bump('click'), { once: true });
    return (el.textContent || '').trim().slice(0, 40);
  })()`);
  assert(marked !== null, `could not find the element for: ${label}`);
  detail(`clicking ${label} (matched ${JSON.stringify(marked)})`);

  const { root } = await target.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await target.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: `[${MARK}]`,
  });
  assert(nodeId, `element for ${label} was not addressable via the DOM domain`);
  /**
   * Where the element is RIGHT NOW.
   *
   * Re-measured before every dispatch, and that is the fix for the intermittent
   * CI failure rather than a defensive habit. The evidence, from the diagnostics
   * the run now prints when a click is lost:
   *
   *   display 1920x1080 fits the window 1440x900        ← the display is fine
   *   screenX:10 screenY:10 outer 1440x900              ← the window is fully on it
   *   hasFocus: true  visibility: visible               ← and it has focus
   *   mousedown=0 mouseup=0 click=0                     ← yet nothing arrived
   *
   * With the environment cleared, what is left is aiming: the coordinates were
   * computed ONCE, before `Page.bringToFront` and the focus wait — which on CI can
   * take seconds, while the dashboard is still mounting and re-laying out. Every
   * retry then dispatched at that same stale point, so a button that moved by a few
   * pixels was missed by all five attempts. On a fast run the app happens to settle
   * before the measurement, which is why the failure correlated with timing and
   * never reproduced on a machine that starts the app quicker.
   */
  const measure = async () => {
    await target.send('DOM.scrollIntoViewIfNeeded', { nodeId });
    await sleep(120);
    const { quads } = await target.send('DOM.getContentQuads', { nodeId });
    if (!quads?.length) return null; // not laid out (yet); the caller retries
    const quad = quads[0];
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  };

  let delivered = { down: 0, up: 0, click: 0 };
  let attempts = 0;
  let point = await measure();
  for (; attempts < 4; attempts++) {
    point = (await measure()) ?? point;
    if (!point) {
      await sleep(250);
      continue;
    }
    await target.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await target.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await target.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(120);
    delivered = await target.eval(`window.__gateClick || { down: 0, up: 0, click: 0 }`);
    if (delivered.click) break;
    // Nothing arrived. The element may have moved since the measurement; the next
    // iteration measures again before dispatching.
    await sleep(250);
  }
  if (attempts > 0) detail(`${label}: input needed ${attempts + 1} attempt(s)`);
  await target.eval(`document.querySelector('[${MARK}]')?.removeAttribute('${MARK}')`);
  if (!delivered.click) {
    // Gather the geometry, because this failure is intermittent on CI and the
    // first three explanations I tried were all wrong. What is known: the page is
    // mounted, its DOM is queryable, `Page.bringToFront` was called, the retry
    // loop ran all 4 extra attempts, and the element's own listeners never fired —
    // i.e. the input went somewhere that is not this window. Whether that is
    // "window off-screen", "window not mapped", "pointer root focus" or "a second
    // window took it" is exactly what these numbers distinguish.
    const geo = await target.eval(`(() => ({
      screenX: window.screenX, screenY: window.screenY,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
    }))()`);
    let bounds = null;
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page');
      bounds = (await cdp.send('Browser.getWindowBounds', {
        windowId: (await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId })).windowId,
      })).bounds;
    } catch (e) {
      bounds = `unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
    detail(`geometry at failure: ${JSON.stringify(geo)} window=${JSON.stringify(bounds)}`);
    detail(`page targets at failure: ${JSON.stringify((await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').map((t) => t.url.slice(0, 60)))}`);
    // Deliberately a different message from "the control was not found" and
    // from "the app ignored the click": this is the environment, not the code.
    throw new Error(
      `the click at (${Math.round(point.x)},${Math.round(point.y)}) for ${label} was never delivered to the page ` +
        `(mousedown=${delivered.down} mouseup=${delivered.up} click=${delivered.click}) after ${attempts + 1} attempts. ` +
        `geometry=${JSON.stringify(geo)} window=${JSON.stringify(bounds)}. ` +
        'Synthetic input reached nothing — this is the environment, not the view under test.',
    );
  }
  detail(`${label}: click delivered (down=${delivered.down} up=${delivered.up} click=${delivered.click})`);
}

/**
 * Put the browser window back out of the user's way.
 *
 * Needed more than once because opening a target restores the window: measured,
 * the window is `minimized` after launch and `normal` by the end of a run — the
 * popup targets created for the alarm check are what raise it (a new tab
 * activates). Until this existed the gate un-minimized itself halfway through,
 * which is exactly what the user saw.
 *
 * No-op on a hosted runner, where there is no user and the window must stay on
 * the X screen (an off-screen window under Xvfb receives no synthetic input).
 */
async function hideWindow(cdp) {
  if (ON_CI_RUNNER) return;
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) return;
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } catch (e) {
    detail(`could not hide the browser window: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Locator bodies: each returns one element or null. */
const LOCATE = {
  /** A nav tab button whose label is exactly `设置`. */
  settingsTab: `() => [...document.querySelectorAll('nav button, button')].find((b) => (b.textContent || '').trim() === '设置')`,
  /** The button carrying the backup-download label. */
  exportBackup: `() => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('下载 JSON 备份'))`,
  /**
   * The auto-sync switch. There are several identical switches on that card, so
   * the row is identified by its label and required to contain exactly one
   * checkbox — the outer containers match the text too but hold several.
   */
  autoSyncSwitch: `() => {
    const rows = [...document.querySelectorAll('div')].filter((d) =>
      (d.textContent || '').includes('后台自动更新') &&
      d.querySelectorAll('input[type=checkbox]').length === 1);
    const row = rows[rows.length - 1];
    return row ? row.querySelector('input[type=checkbox]') : null;
  }`,
};

/** Feed a real file into a real <input type=file>, firing the change handler. */
async function setFileInput(target, selector, filePath) {
  const { root } = await target.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await target.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  assert(nodeId, `no file input matching ${selector}`);
  await target.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
}

// ---------------------------------------------------------------- in-page probes

/** Reads the extension's own Dexie tables through raw IndexedDB. */
function readStores(storeNames) {
  return `(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('CreatorFeedHubDB');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const read = (store) => new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const out = {};
    for (const name of ${JSON.stringify(storeNames)}) out[name] = await read(name);
    db.close();
    return out;
  })()`;
}

function deleteStoreRows(storeNames) {
  return `(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('CreatorFeedHubDB');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(${JSON.stringify(storeNames)}, 'readwrite');
      for (const name of ${JSON.stringify(storeNames)}) tx.objectStore(name).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return true;
  })()`;
}

/** Key-order-insensitive stringify, so "same data" is what gets compared. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function byId(rows) {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** The probe library: one creator, one channel, two posts, distinctive values. */
function fixture() {
  const now = Date.UTC(2026, 8, 11, 12, 0, 0);
  return {
    version: '1.0',
    exportedAt: new Date(now).toISOString(),
    creators: [
      {
        id: 'gate_creator',
        name: '门禁样例博主',
        avatar: '',
        tags: ['门禁', '样例'],
        note: 'written by e2e/release-gate.mjs',
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
    channels: [
      {
        id: 'bilibili:GATE0001',
        creatorId: 'gate_creator',
        platform: 'bilibili',
        accountId: 'GATE0001',
        displayName: '门禁样例频道',
        label: '主账号',
        accountRole: 'main',
        profileUrl: 'https://space.bilibili.com/GATE0001',
        status: 'idle',
      },
    ],
    posts: [
      {
        id: 'gate_post_read',
        creatorId: 'gate_creator',
        channelId: 'bilibili:GATE0001',
        platform: 'bilibili',
        channelLabel: '主账号',
        title: '门禁样例 · 已读+收藏',
        content: '正文含标点与换行：第一行\n第二行 "引号" ✓',
        mediaList: [],
        originalUrl: 'https://www.bilibili.com/video/GATE0001',
        publishedAt: now,
        fetchedAt: now,
        isRead: 1,
        isBookmarked: 1,
      },
      {
        id: 'gate_post_unread',
        creatorId: 'gate_creator',
        channelId: 'bilibili:GATE0001',
        platform: 'bilibili',
        title: '门禁样例 · 未读+配图',
        content: '未读样例正文',
        mediaList: [
          {
            type: 'image',
            previewUrl: 'https://i0.hdslb.com/bfs/archive/gate-sample.jpg',
            originalUrl: 'https://i0.hdslb.com/bfs/archive/gate-sample.jpg',
          },
        ],
        originalUrl: 'https://www.bilibili.com/video/GATE0002',
        publishedAt: now - 3_600_000,
        fetchedAt: now,
        isRead: 0,
        isBookmarked: 0,
      },
    ],
    // Only the values asserted on: the export merges these over the defaults,
    // so the stored settings object is not (and need not be) what comes back.
    settings: { itemsPerFetch: 25, enableAutoSync: false },
  };
}

// ---------------------------------------------------------------- the run

const startedAt = Date.now();
let chrome;
let cleanup = async () => {};

const watchdog = setTimeout(() => {
  out('');
  out(`E2E RESULT: FAILED — watchdog fired after ${RUN_TIMEOUT_MS} ms`);
  void cleanup().finally(() => process.exit(2));
}, RUN_TIMEOUT_MS);

// A gate that leaks a 200 MB profile (or a stray browser) is a gate people stop
// running. `cleanup` is a no-op until the harness is up, and is reassigned as
// soon as there is something to tear down.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    out(`\nreceived ${signal} — tearing down`);
    void cleanup().finally(() => process.exit(130));
  });
}
// `… | head` closes stdout early. Without this the EPIPE ends the process before
// the cleanup below runs, leaving the profile and the browser behind.
process.stdout.on('error', () => {});

try {
  const chromePath = findChrome();
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-e2e-'));
  const downloadsDir = path.join(profileRoot, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });

  out(`Chorus release gate — ${new Date().toISOString()}`);
  out(`  chrome    ${chromePath}`);
  out(`  extension ${EXT_DIR}`);
  out(`  profile   ${profileRoot}`);
  out('');

  cleanup = async () => {
    if (chrome) await killChrome(chrome.child, chrome.cdp);
    if (!KEEP_PROFILE) {
      try {
        fs.rmSync(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (err) {
        out(`  note  could not remove ${profileRoot}: ${err.message}`);
      }
    } else {
      out(`  note  profile kept at ${profileRoot}`);
    }
  };

  const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  await step('build.artifact', [], async () => {
    assert(fs.existsSync(EXT_DIR), `built extension not found: ${EXT_DIR} (run \`npm run build\`)`);
    const manifestPath = path.join(EXT_DIR, 'manifest.json');
    assert(fs.existsSync(manifestPath), `no manifest.json in ${EXT_DIR}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // First three components must match `package.json`, which is what catches a
    // stale `.output/` being shipped as a new build. A fourth component is
    // allowed and only used for a store resubmission — same code, same tag, a
    // version the store will accept (see `manifestVersion` in wxt.config.ts).
    const [want, got] = [pkgVersion, manifest.version];
    assert(
      got === want || got.startsWith(`${want}.`),
      `built manifest version ${got} is not ${want} (or ${want}.<store revision>) — stale .output/?`,
    );
    if (got !== want) {
      const revision = got.slice(want.length + 1);
      assert(
        /^\d+$/.test(revision) && Number(revision) <= 65535,
        `manifest version ${got}: the store-revision component must be an integer 0-65535, got ${JSON.stringify(revision)}`,
      );
    }
    detail(`manifest v${manifest.version} (${manifest.permissions.join(', ')})`);
    return manifest;
  });

  chrome = await step('host.launch', ['build.artifact'], async () => {
    const instance = await launchChrome({ chromePath, profileDir: profileRoot });
    detail(instance.chromeVersion);
    return instance;
  });

  const cdp = chrome?.cdp;

  // The window must FIT the display, or every click near the window's edge is
  // silently dropped.
  //
  // This is the actual cause of the intermittent CI failures that survived three
  // wrong explanations (window off-screen from `--window-position`, a window not
  // yet mapped, a retry budget too short). The gate's window is 1440x900 and
  // `xvfb-run`'s default screen is 1280x1024 — 160px NARROWER — so Chrome centres
  // the window at x = -80 and the left edge of the page, where the nav tabs are,
  // is off the display. `Input.dispatchMouseEvent` then succeeds while the page
  // receives nothing. It never reproduced locally because a developer screen is
  // wider (measured here: 2560x1440), which is exactly why the failure read as
  // mysterious.
  //
  // The workflows now pass `-s "-screen 0 1920x1080x24"`. This asserts the result,
  // because the next time someone changes the window size or the runner image, the
  // failure should name the geometry instead of manifesting as dropped clicks.
  await step('host.display-fits-window', ['host.launch'], async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    assert(page, 'no page target to measure the display from');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const probeTarget = await new Target(cdp, sessionId, 'display').init({ page: false });
    const probe = await probeTarget.eval(
      `({ screen: [screen.width, screen.height], outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight] })`,
    );
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    const [[sw, sh], [ow, oh]] = [probe.screen, probe.outer];
    assert(
      ow <= sw && oh <= sh,
      `the browser window is ${ow}x${oh} but the display is only ${sw}x${sh}. ` +
        'A window larger than the screen is centred with its left edge off the display, and ' +
        'clicks there are dropped by the X server without an error — the exact failure this gate ' +
        'kept hitting. On CI, raise the Xvfb screen (`xvfb-run -s "-screen 0 1920x1080x24"`).',
    );
    detail(`display ${sw}x${sh} fits the window ${ow}x${oh}`);
    return probe;
  });

  const load = await step('host.load-extension', ['host.launch'], async () => {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
    assert(id, 'Extensions.loadUnpacked returned no id');
    detail(`extension id ${id}`);
    return id;
  });

  const dashboard = await step('dashboard.mounts', ['host.load-extension'], async () => {
    const { targetId } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${load}/dashboard.html`,
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = await new Target(cdp, sessionId, 'dashboard').init({ page: true });
    const runtimeId = await page.wait(  // proves it is a real extension page, not a file:// copy
      'the dashboard to report its extension id',
      () => page.eval('typeof chrome === "object" && chrome.runtime && chrome.runtime.id'),
    );
    assert(runtimeId === load, `dashboard reports extension id ${runtimeId}, expected ${load}`);
    await page.wait('the app to mount (nav tabs rendered)', () =>
      page.eval(
        `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '设置')`,
      ),
    );
    detail(`chrome.runtime.id ${runtimeId}`);
    return page;
  });

  // Start the download capture before the click that produces one.
  await step('backup.arm-downloads', ['host.load-extension'], async () => {
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadsDir,
      eventsEnabled: true,
    });
    return downloadsDir;
  });

  // The popup's post-follow fetch route, end to end through the real router and
  // the real service worker. It is checked here rather than only in a unit test
  // because three of its properties live in the extension host and nowhere else:
  // the sender policy table has to admit the type, the handler has to be reached
  // (a missing dispatch arm answers nothing and the caller's promise hangs), and
  // the channel has to come from the worker's own database.
  //
  // Both cases below are deliberately network-free. An unknown id proves the
  // worker looked the channel up instead of trusting the message; a channel on a
  // platform with no adapter proves the fetch actually ran and had its failure
  // reported rather than swallowed — `updateChannel` resolves with `error`, it
  // does not throw, so a handler that only catches calls this a success.
  await step('syncChannel.message-round-trip', ['dashboard.mounts'], async () => {
    const probe = `
      (async () => {
        const send = (msg) => chrome.runtime.sendMessage(msg).then(
          (r) => ({ answered: true, response: r }),
          (e) => ({ answered: false, error: String(e && e.message || e) }),
        );
        const unknown = await send({ type: 'SYNC_CHANNEL', channelId: 'nope:missing' });
        const db = await new Promise((res, rej) => {
          const q = indexedDB.open('CreatorFeedHubDB');
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        await new Promise((res, rej) => {
          const tx = db.transaction('channels', 'readwrite');
          tx.objectStore('channels').put({
            id: 'nope:1', creatorId: 'c_probe', platform: 'nope', accountId: 'probe',
            displayName: 'no-adapter platform', status: 'idle', profileUrl: 'https://example.com/x',
          });
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
        db.close();
        const unsupported = await send({ type: 'SYNC_CHANNEL', channelId: 'nope:1', limit: 3 });
        // Remove the probe row: later steps assert on exact row counts, and a
        // leftover channel here made the fixture import wait forever for a count
        // that could no longer be reached.
        const db2 = await new Promise((res, rej) => {
          const q = indexedDB.open('CreatorFeedHubDB');
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        await new Promise((res, rej) => {
          const tx = db2.transaction('channels', 'readwrite');
          tx.objectStore('channels').delete('nope:1');
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
        db2.close();
        return { unknown, unsupported };
      })()`;
    const out = await dashboard.eval(probe);
    assert(out.unknown?.answered, `the worker never answered SYNC_CHANNEL: ${JSON.stringify(out.unknown)}`);
    assert(
      out.unknown.response?.success === false && /不存在/.test(String(out.unknown.response.error)),
      `an unknown channelId was not refused: ${JSON.stringify(out.unknown.response)}`,
    );
    assert(
      out.unsupported?.answered,
      `the worker never answered the second SYNC_CHANNEL: ${JSON.stringify(out.unsupported)}`,
    );
    assert(
      out.unsupported.response?.success === false && /不支持的平台/.test(String(out.unsupported.response.error)),
      `a sync that resolved with an error was not reported as one: ${JSON.stringify(out.unsupported.response)}`,
    );
    detail(`unknown id refused; unsupported platform reported: ${out.unsupported.response.error}`);
    return out;
  });

  const seeded = await step('backup.seed-fixture', ['dashboard.mounts', 'backup.arm-downloads'], async () => {
    // Stay on the settings tab from here on: the feed marks rendered posts as
    // read, which would change the very rows this round trip compares.
    await clickLocated(dashboard, LOCATE.settingsTab, '设置 tab');
    await dashboard.wait('the backup card to render', () =>
      dashboard.eval(`[...document.querySelectorAll('button')].some((b) => (b.textContent||'').includes('下载 JSON 备份'))`),
    );
    const fixturePath = path.join(profileRoot, 'fixture-backup.json');
    const data = fixture();
    fs.writeFileSync(fixturePath, JSON.stringify(data, null, 2));
    await setFileInput(dashboard, 'input[type=file][accept=".json"]', fixturePath);
    const rows = await dashboard.wait('the fixture rows to land in the database', async () => {
      const stores = await dashboard.eval(readStores(['creators', 'channels', 'posts']));
      return stores.creators.length === 1 && stores.channels.length === 1 && stores.posts.length === 2
        ? stores
        : null;
    });
    detail(`imported fixture: ${rows.creators.length} creator / ${rows.channels.length} channel / ${rows.posts.length} posts`);
    return data;
  });

  const exported = await step('backup.export', ['backup.seed-fixture'], async () => {
    await clickLocated(dashboard, LOCATE.exportBackup, '下载 JSON 备份');
    const file = await (async () => {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      for (;;) {
        const names = fs.readdirSync(downloadsDir).filter((n) => BACKUP_FILE_RE.test(n));
        if (names.length) {
          // A download in flight still parses as truncated JSON, so the parse is
          // the readiness check rather than the file's existence.
          try {
            const raw = fs.readFileSync(path.join(downloadsDir, names[0]), 'utf8');
            const parsed = JSON.parse(raw);
            return { name: names[0], bytes: Buffer.byteLength(raw), data: parsed };
          } catch {
            /* keep waiting */
          }
        }
        if (Date.now() > deadline) {
          throw new Error(
            `no complete ${BACKUP_FILE_RE} in ${downloadsDir} within ${WAIT_TIMEOUT_MS}ms ` +
              `(found: ${JSON.stringify(fs.readdirSync(downloadsDir))})`,
          );
        }
        await sleep(250);
      }
    })();

    assert(file.data.version === '1.0', `exported version is ${JSON.stringify(file.data.version)}`);
    assert(file.data.exportedAt, 'exported backup has no exportedAt');
    for (const section of ['creators', 'channels', 'posts']) {
      assert(Array.isArray(file.data[section]), `exported ${section} is not an array`);
    }
    assert(file.data.settings && typeof file.data.settings === 'object', 'exported settings is not an object');
    detail(`${file.name}, ${file.bytes} B, creators=${file.data.creators.length} channels=${file.data.channels.length} posts=${file.data.posts.length}`);
    return file;
  });

  await step('backup.import-export-lossless', ['backup.export'], async () => {
    // The exported rows must be the rows that went in: import ran the real
    // parseBackup + restoreBackup, export ran createBackup, and nothing in
    // between is allowed to lose a field.
    for (const section of ['creators', 'channels', 'posts']) {
      assert(
        stable(byId(exported.data[section])) === stable(byId(seeded[section])),
        `exported ${section} differ from the imported fixture:\n  in : ${stable(byId(seeded[section]))}\n  out: ${stable(byId(exported.data[section]))}`,
      );
    }
    assert(exported.data.settings.itemsPerFetch === 25, 'exported settings lost itemsPerFetch=25');
    detail('creators/channels/posts round trip byte-equal');
  });

  await step('backup.destroy', ['backup.export'], async () => {
    await dashboard.eval(deleteStoreRows(['creators', 'channels', 'posts']));
    const rows = await dashboard.wait('the probe rows to be gone', async () => {
      const stores = await dashboard.eval(readStores(['creators', 'channels', 'posts']));
      return stores.creators.length + stores.channels.length + stores.posts.length === 0 ? stores : null;
    });
    detail(`destroyed: ${rows.creators.length + rows.channels.length + rows.posts.length} rows remain`);
  });

  await step('backup.reimport-restores', ['backup.destroy'], async () => {
    const exportedPath = path.join(downloadsDir, exported.name);
    await setFileInput(dashboard, 'input[type=file][accept=".json"]', exportedPath);
    const rows = await dashboard.wait('the exported file to restore the rows', async () => {
      const stores = await dashboard.eval(readStores(['creators', 'channels', 'posts']));
      return stores.posts.length === 2 ? stores : null;
    });
    for (const section of ['creators', 'channels', 'posts']) {
      assert(
        stable(byId(rows[section])) === stable(byId(seeded[section])),
        `restored ${section} differ from the fixture:\n  want: ${stable(byId(seeded[section]))}\n  got : ${stable(byId(rows[section]))}`,
      );
    }
    const settingsRow = (await dashboard.eval(readStores(['settings']))).settings
      .find?.((row) => row.key === 'app_settings');
    assert(
      settingsRow?.value?.itemsPerFetch === 25,
      `restored settings lost itemsPerFetch=25 (got ${JSON.stringify(settingsRow?.value?.itemsPerFetch)})`,
    );
    detail('rows and settings restored from the exported file');
  });

  // --- alarm: the regression AGENTS rule 7 records -------------------------

  const swTarget = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(load));
  };

  /** Attach to the running worker and read its alarm list. */
  async function readAlarms(wake) {
    if (wake) await wake();
    const info = await swTarget();
    assert(info, 'the extension service worker is not running');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    const worker = await new Target(cdp, sessionId, 'service-worker').init({ page: false });
    try {
      return await worker.eval('chrome.alarms.getAll()');
    } finally {
      try {
        await cdp.send('Target.detachFromTarget', { sessionId });
      } catch {
        /* the worker may have been torn down mid-read */
      }
    }
  }

  const alarmIn = (list) => (Array.isArray(list) ? list.find((a) => a.name === ALARM_NAME) : undefined);

  const enabled = await step('alarm.enable-auto-sync', ['backup.reimport-restores'], async () => {
    await clickLocated(dashboard, LOCATE.autoSyncSwitch, '后台自动更新 switch');
    // Read the persisted setting first: it separates "the toggle did not land"
    // from "the toggle landed and the worker still did not create the alarm".
    const stored = await dashboard.wait('enableAutoSync to be persisted', async () => {
      const rows = await dashboard.eval(readStores(['settings']));
      const row = rows.settings.find((r) => r.key === 'app_settings');
      return row?.value?.enableAutoSync === true ? row.value : null;
    });
    detail(`settings row: enableAutoSync=${stored.enableAutoSync}`);
    const alarms = await dashboard.wait('the alarm to be created by the settings change', async () => {
      // The switch posts UPDATE_AUTO_SYNC, which wakes the worker; that wake is
      // the path that must not restart the countdown.
      const list = await readAlarms();
      return alarmIn(list) ? list : null;
    });
    const alarm = alarmIn(alarms);
    assert(
      alarm.periodInMinutes === ALARM_PERIOD_MINUTES,
      `alarm period is ${alarm.periodInMinutes}, expected ${ALARM_PERIOD_MINUTES}`,
    );
    detail(`alarm created: ${alarm.name}, period ${alarm.periodInMinutes} min, scheduledTime=${alarm.scheduledTime}`);
    return alarm;
  });

  const popupAlarms = await step('alarm.survives-popup-opens', ['alarm.enable-auto-sync'], async () => {
    assert(enabled, 'no alarm existed after the settings change');
    for (let i = 0; i < 3; i++) {
      const { targetId } = await cdp.send('Target.createTarget', {
        url: `chrome-extension://${load}/popup.html`,
      });
      await hideWindow(cdp); // opening a target restores the window
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const popup = await new Target(cdp, sessionId, `popup#${i + 1}`).init({ page: true });
      await popup.wait('popup.html to report its extension id', () =>
        popup.eval('typeof chrome === "object" && chrome.runtime && chrome.runtime.id'),
      );
      await cdp.send('Target.closeTarget', { targetId });
      // Closing a target can also restore the window (observed intermittently: the
      // end-of-run assertion caught the window back in `normal` state after this
      // loop). Closing the last tab of a non-primary window makes Chrome re-map the
      // remaining one, and the re-map does not preserve `minimized`. So hide again
      // here, not only after creation.
      await hideWindow(cdp);
    }
    const list = await readAlarms();
    const alarm = alarmIn(list);
    assert(alarm, `the ${ALARM_NAME} alarm is gone after opening the popup 3 times`);
    assert(
      alarm.scheduledTime === enabled.scheduledTime,
      `opening the popup moved scheduledTime ${enabled.scheduledTime} → ${alarm.scheduledTime}`,
    );
    detail(`after 3 popup opens: scheduledTime=${alarm.scheduledTime} (unchanged)`);
    return alarm;
  });

  const afterRestart = await step('alarm.survives-worker-restart', ['alarm.enable-auto-sync'], async () => {
    assert(enabled, 'no alarm existed after the settings change');
    // The sharper version of "a wake happened": stop the worker outright. Without
    // this the check would be vacuous — a worker that was never torn down does
    // not re-run setupAutoSync at all, so it could not reset anything either way.
    //
    // `ServiceWorker.enable` is only exposed on a PAGE session; on the browser
    // session Chrome answers "'ServiceWorker.enable' wasn't found".
    let version;
    try {
      await dashboard.send('ServiceWorker.enable');
      version = await new Promise((resolve) => {
        const off = cdp.onEvent((msg) => {
          if (msg.method !== 'ServiceWorker.workerVersionUpdated') return;
          const match = (msg.params.versions || []).find(
            (v) => v.scriptURL?.includes(load) && v.status === 'activated',
          );
          if (match) {
            off();
            resolve(match);
          }
        });
        setTimeout(() => {
          off();
          resolve(null);
        }, 5000);
      });
    } catch (err) {
      throw new Skipped(`ServiceWorker domain unavailable on this Chrome: ${err.message}`);
    }
    if (!version) throw new Skipped('ServiceWorker.enable reported no activated worker version');
    await dashboard.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    const stopped = await (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (!(await swTarget())) return true;
        await sleep(200);
      }
      return false;
    })();
    assert(stopped, `the worker was still listed ${10_000}ms after stopWorker`);

    // Reading the alarm needs a running worker, and waking it is the path under
    // test: the cold start re-runs setupAutoSync, which the `alarms.get` guard
    // must keep from restarting the countdown.
    const list = await readAlarms(async () => {
      await dashboard.eval(`chrome.runtime.sendMessage({ type: 'UPDATE_AUTO_SYNC' })`);
    });
    const alarm = alarmIn(list);
    assert(alarm, `the ${ALARM_NAME} alarm did not survive a worker restart`);
    assert(
      alarm.scheduledTime === enabled.scheduledTime,
      `the worker restart moved scheduledTime ${enabled.scheduledTime} → ${alarm.scheduledTime}`,
    );
    detail(`worker stopped cold and woken again: scheduledTime=${alarm.scheduledTime} (unchanged)`);
    return alarm;
  });

  await step('alarm.scheduled-time-unchanged', ['alarm.enable-auto-sync'], async () => {
    assert(enabled, 'no alarm existed after the settings change');
    const readings = {
      'settings toggle': enabled?.scheduledTime,
      '3 popup opens': popupAlarms?.scheduledTime,
    };
    if (afterRestart) readings['worker restart'] = afterRestart.scheduledTime;
    for (const [label, value] of Object.entries(readings)) {
      assert(value, `no ${ALARM_NAME} alarm present at reading "${label}" — it was cleared or lost`);
    }
    const distinct = new Set(Object.values(readings));
    assert(
      distinct.size === 1,
      `scheduledTime changed across readings (${JSON.stringify(readings)}) — a wake restarted the countdown`,
    );
    detail(
      `${Object.keys(readings).length} readings (${Object.keys(readings).join(' → ')}), ` +
        `scheduledTime ${[...distinct][0]} (Δ 0 ms)`,
    );
  });

  // The other half of the same contract: switching it off must stop the
  // periodic work, which only happens if the alarm is actually gone.
  await step('alarm.cleared-when-disabled', ['alarm.enable-auto-sync'], async () => {
    assert(enabled, 'no alarm existed after the settings change');
    await clickLocated(dashboard, LOCATE.autoSyncSwitch, '后台自动更新 switch (off)');
    const cleared = await dashboard.wait('the alarm to be cleared', async () => {
      const list = await readAlarms();
      return alarmIn(list) ? null : true;
    });
    assert(cleared, `the ${ALARM_NAME} alarm is still present after switching auto-sync off`);
    detail('alarm cleared after switching auto-sync off');
  });
  // The window must still be out of the user's way at the END of the run.
  //
  // This is not decoration: the run un-minimized itself once, because a
  // `Page.bringToFront` added for CI's focus problem was applied everywhere, and
  // every click raised the browser onto the user's screen. Asserting the state at
  // the end is what turns "we minimize it at startup" into "nothing raises it
  // again", which is the property that actually matters.
  if (!ON_CI_RUNNER) {
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page');
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId });
      const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
      assert(
        bounds.windowState === 'minimized',
        `the browser window is ${JSON.stringify(bounds.windowState)} at the end of the run — ` +
          'something un-minimized it, i.e. it was on the user\'s screen. On CI the window stays ' +
          'on screen deliberately; locally it must stay minimized.',
      );
      out('  window stayed minimized for the whole run (never raised in front of the user)');
    } catch (e) {
      if (e instanceof Error && e.message.includes('un-minimized')) throw e;
      // Best-effort: a CDP hiccup must not fail the gate — but it MUST say so.
      // A silently-skipped check is indistinguishable from a passing one, which
      // is the failure mode this whole area keeps producing.
      out(`  (could not verify the window state at the end: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
} catch (err) {
  // A harness error (no Chrome, bad path) is not a product failure, but it
  // still has to fail the run loudly — with the message first, the stack only
  // when asked for.
  out('');
  out(`E2E RESULT: FAILED — harness error: ${err instanceof Error ? err.message : String(err)}`);
  if (VERBOSE && err instanceof Error && err.stack) out(err.stack);
  clearTimeout(watchdog);
  await cleanup();
  process.exit(1);
}

clearTimeout(watchdog);
await cleanup();

const failed = steps.filter((s) => s.status === 'fail');
const skipped = steps.filter((s) => s.status === 'skip');
out('');
out(
  `E2E RESULT: ${failed.length ? 'FAILED' : 'PASSED'} — ` +
    `${steps.filter((s) => s.status === 'pass').length} passed, ${failed.length} failed, ` +
    `${skipped.length} skipped, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
);
// Skipped checks are listed with their reason: a check that could not run is a
// gap in the evidence, and it must be as visible as a failure (rule 26).
for (const s of skipped) out(`  skip  ${s.name}: ${s.error}`);
for (const s of failed) out(`  FAIL  ${s.name}: ${s.error}`);
process.exit(failed.length ? 1 : 0);
