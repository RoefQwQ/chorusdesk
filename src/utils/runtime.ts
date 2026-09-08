/**
 * Execution-context detection.
 *
 * MV3 service workers and extension pages share the `chrome.*` API surface but
 * differ in one way that matters for messaging: `chrome.runtime.sendMessage`
 * is never delivered to listeners in the context that sent it. Code reachable
 * from both the background (alarms, auto-sync) and the dashboard/popup must
 * therefore call background helpers directly when it is already running inside
 * the service worker.
 *
 * Detected via the absence of `window`: extension pages, content scripts and
 * plain-browser dev builds all have one, the service worker does not. We avoid
 * naming `ServiceWorkerGlobalScope` because that type requires the `WebWorker`
 * lib, which conflicts with the `DOM` lib this project needs for its Vue UI.
 *
 * Evaluated once at module load: a realm never changes kind.
 */
export const IS_SERVICE_WORKER = typeof window === 'undefined' && typeof self !== 'undefined';
