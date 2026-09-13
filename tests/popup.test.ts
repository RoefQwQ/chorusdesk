import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import PopupApp from '../entrypoints/popup/App.vue';

/**
 * The popup's chrome: exactly one way to reach the dashboard.
 *
 * Observed by the user: 「右下角和右上角的功能重复了」 — the popup offered
 * 「打开面板」 as a button in the header *and* as a link in the footer, both calling
 * the same `openDashboard`, inside a 460px-tall popup where the two are visible
 * simultaneously. That is not a shortcut; it is the same action twice.
 *
 * Counted as **controls**, not as occurrences of the label: the surviving button
 * carries that text twice (as its `title` and as its visible label), so a naive
 * string count reports 2 and would keep passing whether or not the duplicate came
 * back.
 */

/** Every `<button>` in the rendered markup, with its inner HTML. */
function buttonsIn(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
}

const DASHBOARD_LABEL = '打开面板';

async function renderPopup(): Promise<string> {
  const app = createSSRApp({ render: () => h(PopupApp as never) });
  return renderToString(app);
}

describe('popup — dashboard access', () => {
  it('offers the dashboard action exactly once', async () => {
    const html = await renderPopup();

    const dashboardControls = buttonsIn(html).filter((inner) => inner.includes(DASHBOARD_LABEL));
    expect(dashboardControls).toHaveLength(1);
  });

  it('keeps it labelled and named for assistive tech', async () => {
    // The header button is the one kept: it is a real `<button>` with a title,
    // unlike the footer's bare link-styled control.
    const html = await renderPopup();

    expect(html).toContain(`title="${DASHBOARD_LABEL}"`);
    // Exactly one control, so exactly one accessible name for it.
    expect(html.match(/>打开面板</g) ?? []).toHaveLength(1);
  });

  it('still renders the follow count in the footer', async () => {
    // The footer lost its duplicate action, not its purpose.
    const html = await renderPopup();

    expect(html).toContain('关注');
  });
});

describe('popup — no second dashboard action in any body state', () => {
  it('renders the already-followed card with no dashboard control of its own', async () => {
    // That card used to carry a 「查看动态」 button calling the same `openDashboard`
    // as the header — the same action twice, and under a label promising something
    // it did not do (it opens the dashboard, not that creator's feed). Checked here
    // rather than through the popup's own render: the popup only reaches this state
    // with a real detected page and a matching stored channel.
    const html = await renderAlreadyFollowed();

    expect(buttonsIn(html)).toHaveLength(0);
    // Still says what it is for.
    expect(html).toContain('已关注');
    expect(html).toContain('测试创作者');
  });
});

/**
 * The follow succeeded but its first fetch did not — the capability chain's last
 * mile.
 *
 * `backgroundSync: false` platforms (douyin, twitter) cannot be synced from the
 * service worker, and the popup delegates the first fetch there. The worker
 * reports that honestly; the popup used to drop the answer into `console.warn`,
 * so the observable result was 「已关注」 followed by an empty feed and no reason
 * anywhere the user could see.
 */
describe('popup — a refused first sync is told to the user', () => {
  it('shows the reason and the next step when the platform cannot sync in the background', async () => {
    const html = await renderAlreadyFollowed('推特需要在扩展页面中同步，后台无法采集。');

    expect(html).toContain('首次同步未完成');
    expect(html).toContain('推特需要在扩展页面中同步');
    // The reason alone leaves the user with nothing to do, and nothing retries.
    expect(html).toContain('打开面板');
  });

  it('says nothing when the first sync succeeded', async () => {
    // The ordinary case must stay clean: a warning that fires when everything
    // worked reads as a problem when there is none (AGENTS rule 23).
    for (const value of [null, undefined, '']) {
      const html = await renderAlreadyFollowed(value);
      expect(html).not.toContain('首次同步未完成');
    }
  });
});

/** Render `AlreadyFollowedCard` with the given first-sync outcome. */
async function renderAlreadyFollowed(firstSyncError?: string | null): Promise<string> {
  const { default: AlreadyFollowedCard } = await import(
    '../entrypoints/popup/components/AlreadyFollowedCard.vue'
  );
  return renderToString(
    createSSRApp({
      render: () =>
        h(AlreadyFollowedCard as never, {
          existingChannel: { id: 'bilibili:1', displayName: 'x' },
          existingCreator: { name: '测试创作者' },
          firstSyncError,
        }),
    }),
  );
}
