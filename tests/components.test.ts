import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import PlatformBadge from '../entrypoints/dashboard/components/creator/PlatformBadge.vue';
import ChannelRow from '../entrypoints/dashboard/components/creator/ChannelRow.vue';
import CreatorCardHeader from '../entrypoints/dashboard/components/creator/CreatorCardHeader.vue';
import BaseModal from '../entrypoints/dashboard/components/BaseModal.vue';
import type { Channel, Creator } from '../src/types';

const creator: Creator = {
  id: 'creator_1',
  name: '测试创作者',
  avatar: '',
  tags: ['绘画'],
  createdAt: 1,
  updatedAt: 1,
};

const channel: Channel = {
  id: 'bilibili:42',
  creatorId: 'creator_1',
  platform: 'bilibili',
  accountId: '42',
  displayName: 'tester',
  status: 'idle',
  label: '主账号',
  profileUrl: 'https://space.bilibili.com/42',
  accountRole: 'main',
};

async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => h(component as never, props) });
  return renderToString(app);
}

describe('creator view components render', () => {
  it('PlatformBadge renders platform name and count', async () => {
    const html = await render(PlatformBadge, { platform: 'bilibili', count: 3, compact: true });
    expect(html).toContain('哔哩哔哩');
    expect(html).toContain('x3');
  });

  it('PlatformBadge falls back to the raw key for unknown platforms', async () => {
    const html = await render(PlatformBadge, { platform: 'unknownplat' });
    expect(html).toContain('unknownplat');
  });

  it('ChannelRow compact mode shows role label and error message', async () => {
    const html = await render(ChannelRow, {
      channel: { ...channel, errorMessage: '登录已过期' },
      creatorId: 'creator_1',
      compact: true,
    });
    expect(html).toContain('主账号');
    expect(html).toContain('登录已过期');
  });

  it('ChannelRow compact mode lays the row out horizontally, not stacked', async () => {
    // Regression: the compact root was `p-1.5 space-y-1` with no flex, so the
    // action buttons were a block sibling of the label and wrapped onto their
    // own line instead of sitting at the right edge. The row content and the
    // button group must share one flex line.
    const html = await render(ChannelRow, { channel, creatorId: 'creator_1', compact: true });
    expect(html).toContain('flex items-center justify-between');
    // The stacked-only utility must not drive the compact row layout any more.
    expect(html).not.toContain('space-y-1');
  });

  it('ChannelRow detailed mode shows avatar fallback letter and @id', async () => {
    const html = await render(ChannelRow, { channel, creatorId: 'creator_1' });
    expect(html).toContain('@42');
    expect(html).toContain('tester');
  });

  it('CreatorCardHeader grid variant shows post count and actions', async () => {
    const html = await render(CreatorCardHeader, {
      creator,
      variant: 'grid',
      postCount: 12,
      avatarUrl: '',
      isBatchMode: false,
      isSelected: false,
      isUpdating: false,
      lastCheckAt: Date.now(),
    });
    expect(html).toContain('测试创作者');
    expect(html).toContain('12 篇作品');
  });

  it('CreatorCardHeader detailed variant shows the deep-sync text button', async () => {
    const html = await render(CreatorCardHeader, {
      creator,
      variant: 'detailed',
      postCount: 0,
      avatarUrl: '',
      isBatchMode: true,
      isSelected: true,
      isUpdating: false,
    });
    expect(html).toContain('回溯历史');
  });
});

describe('BaseModal renders dialog semantics', () => {
  it('exposes role=dialog, aria-modal and the slot', async () => {
    const app = createSSRApp({
      render: () => h(BaseModal, { overlayClass: 'bg-black/50' }, { default: () => h('p', '内容') }),
    });
    const html = await renderToString(app);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('内容');
  });
});
