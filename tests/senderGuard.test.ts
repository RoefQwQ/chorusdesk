import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isContentScriptSenderOn,
  isExtensionPageSender,
} from '../src/infrastructure/chrome/messages/senderGuard';

// senderGuard reads chrome.runtime.id to decide whether the sender belongs to
// this extension; a stable fake id makes the assertions deterministic.
const FAKE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

type Sender = chrome.runtime.MessageSender;

beforeEach(() => {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: FAKE_ID },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

function pageSender(overrides: Partial<Sender> = {}): Sender {
  return {
    id: FAKE_ID,
    origin: `chrome-extension://${FAKE_ID}`,
    url: `chrome-extension://${FAKE_ID}/dashboard.html`,
    ...overrides,
  };
}

describe('isExtensionPageSender', () => {
  it('accepts the extension dashboard and popup', () => {
    expect(isExtensionPageSender(pageSender())).toBe(true);
    expect(
      isExtensionPageSender(pageSender({ url: `chrome-extension://${FAKE_ID}/popup.html` })),
    ).toBe(true);
  });

  it('rejects a different extension id', () => {
    expect(isExtensionPageSender(pageSender({ id: 'bbbb' + FAKE_ID.slice(4) }))).toBe(false);
  });

  it('rejects content scripts (host-page origin despite same id)', () => {
    expect(
      isExtensionPageSender(pageSender({ origin: 'https://rplay.live', url: 'https://rplay.live/feed' })),
    ).toBe(false);
  });

  it('rejects web pages and missing senders', () => {
    expect(
      isExtensionPageSender(pageSender({ origin: 'https://evil.example', url: 'https://evil.example/x' })),
    ).toBe(false);
    expect(isExtensionPageSender({} as Sender)).toBe(false);
  });

  it('falls back to the frame URL when origin is absent', () => {
    expect(isExtensionPageSender(pageSender({ origin: undefined }))).toBe(true);
    expect(
      isExtensionPageSender(
        pageSender({ origin: undefined, url: 'https://evil.example/dashboard.html' }),
      ),
    ).toBe(false);
  });
});

describe('isContentScriptSenderOn', () => {
  it('accepts our content script on the exact host', () => {
    expect(
      isContentScriptSenderOn(
        pageSender({ origin: 'https://rplay.live', url: 'https://rplay.live/live' }),
        'rplay.live',
      ),
    ).toBe(true);
  });

  it('accepts subdomains of the pinned host', () => {
    expect(
      isContentScriptSenderOn(
        pageSender({ origin: 'https://www.rplay.live', url: 'https://www.rplay.live/x' }),
        'rplay.live',
      ),
    ).toBe(true);
  });

  it('rejects content scripts on other hosts', () => {
    expect(
      isContentScriptSenderOn(
        pageSender({ origin: 'https://evil.example', url: 'https://evil.example/rplay.live' }),
        'rplay.live',
      ),
    ).toBe(false);
    expect(
      isContentScriptSenderOn(
        pageSender({ origin: 'https://rplay.live.attacker.tld', url: 'https://rplay.live.attacker.tld/' }),
        'rplay.live',
      ),
    ).toBe(false);
  });

  it('rejects extension pages and missing senders', () => {
    expect(isContentScriptSenderOn(pageSender(), 'rplay.live')).toBe(false);
    expect(isContentScriptSenderOn({} as Sender, 'rplay.live')).toBe(false);
  });
});
