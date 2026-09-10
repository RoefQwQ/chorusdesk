import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import PlatformBadge from '../entrypoints/dashboard/components/creator/PlatformBadge.vue';
import ChannelRow from '../entrypoints/dashboard/components/creator/ChannelRow.vue';
import CreatorCardHeader from '../entrypoints/dashboard/components/creator/CreatorCardHeader.vue';
import BaseModal from '../entrypoints/dashboard/components/BaseModal.vue';
import AppSelect from '../entrypoints/dashboard/components/AppSelect.vue';
import DevLogModal from '../entrypoints/dashboard/components/DevLogModal.vue';
import PostReaderModal from '../entrypoints/dashboard/components/PostReaderModal.vue';
import PostCard from '../entrypoints/dashboard/components/PostCard.vue';
import type { Channel, Creator, Post } from '../src/types';

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

  it('ChannelRow names the source platform', async () => {
    // Regression: the row showed only the role badge ("主账号") and the account
    // name. A creator who binds the same display name on two platforms then has
    // two visually identical rows — you cannot tell which is Bilibili and which
    // is Weibo, which is what made the account list read as role-only.
    const bilibili = await render(ChannelRow, { channel, creatorId: 'creator_1' });
    expect(bilibili).toContain('哔哩哔哩');
    expect(bilibili).toContain('来源平台：哔哩哔哩');

    const weibo: Channel = { ...channel, id: 'weibo:42', platform: 'weibo' };
    const weiboHtml = await render(ChannelRow, { channel: weibo, creatorId: 'creator_1' });
    expect(weiboHtml).toContain('微博');
    // The two rows must be distinguishable from their markup alone.
    expect(weiboHtml).not.toBe(bilibili);
  });

  it('ChannelRow shows the platform in compact mode too', async () => {
    const html = await render(ChannelRow, { channel, creatorId: 'creator_1', compact: true });
    expect(html).toContain('哔哩哔哩');
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

describe('AppSelect renders', () => {
  it('shows the selected label, not the raw value, and exposes the accessible name', async () => {
    const html = await render(AppSelect, {
      modelValue: 10,
      options: [
        { value: 5, label: '5 条' },
        { value: 10, label: '10 条（推荐）' },
      ],
      ariaLabel: '每次获取条数',
    });
    expect(html).toContain('10 条（推荐）');
    expect(html).toContain('aria-label="每次获取条数"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('falls back to the raw value when the option list has no match', async () => {
    // A settings value outside the current option set must still render.
    const html = await render(AppSelect, { modelValue: 999, options: [], ariaLabel: 'x' });
    expect(html).toContain('999');
  });
});

describe('PostReaderModal renders', () => {
  const longPost: Post = {
    id: 'rss_1',
    creatorId: 'creator_1',
    channelId: 'rss:daily',
    platform: 'rss',
    title: '2026-09-08',
    content: '正文段落一\n正文段落二\n' + '长文内容。'.repeat(400),
    mediaList: [],
    originalUrl: 'https://daily.juya.uk/2026/09/08',
    publishedAt: Date.UTC(2026, 8, 8),
    fetchedAt: Date.now(),
    isRead: 0,
  };

  it('renders the whole body inside a dialog, unclamped', async () => {
    const html = await render(PostReaderModal, {
      post: longPost,
      creators: [creator],
      channels: [],
    });

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // The point of this view: no line clamp on the article body.
    expect(html).not.toContain('line-clamp');
    // The tail of a 2000+ character article is rendered, not cut.
    expect(html).toContain('长文内容。长文内容。');
    expect(html).toContain('2026-09-08');
  });

  it('keeps the platform and author identifiable', async () => {
    const html = await render(PostReaderModal, {
      post: longPost,
      creators: [creator],
      channels: [],
    });
    expect(html).toContain('测试创作者');
    expect(html).toContain('通用 RSS');
  });

  it('hides a heading that just repeats the body', async () => {
    const echo: Post = { ...longPost, title: '露露卡', content: '露露卡' };
    const html = await render(PostReaderModal, { post: echo, creators: [creator], channels: [] });
    // The body still renders; the duplicated heading does not.
    expect(html).toContain('露露卡');
    expect(html).not.toContain('<h2');
  });

  it('renders a structured article as markup, not as escaped text', async () => {
    // The user's complaint: the article arrived as one undifferentiated block of
    // text with no typography, because the body was flattened before storage.
    const structured: Post = {
      ...longPost,
      content: '要闻 正文内容',
      contentHtml: '<h2>要闻</h2><p>正文内容</p><ul><li>第一项</li></ul>',
    };
    const html = await render(PostReaderModal, {
      post: structured,
      creators: [creator],
      channels: [],
    });

    expect(html).toContain('article-body');
    expect(html).toContain('<h2>要闻</h2>');
    expect(html).toContain('<li>第一项</li>');
    // Escaped markup would mean the article was rendered as literal text.
    expect(html).not.toContain('&lt;h2&gt;');
  });

  it('does not repeat an inline image in a gallery below the article', async () => {
    const image = {
      type: 'image' as const,
      previewUrl: 'https://assets.example/cover.png',
      originalUrl: 'https://assets.example/cover.png',
    };
    const structured: Post = {
      ...longPost,
      contentHtml: '<p><img src="https://assets.example/cover.png"></p>',
      mediaList: [image],
    };
    const html = await render(PostReaderModal, {
      post: structured,
      creators: [creator],
      channels: [],
    });

    // Rendered once, inline; not a second time as a standalone figure.
    expect(html.match(/assets\.example\/cover\.png/g) ?? []).toHaveLength(1);
  });

  it('still lists an enclosure that has no inline form', async () => {
    const audio = {
      type: 'audio' as const,
      previewUrl: 'https://assets.example/ep.mp3',
      originalUrl: 'https://assets.example/ep.mp3',
    };
    const structured: Post = { ...longPost, contentHtml: '<p>shownotes</p>', mediaList: [audio] };
    const html = await render(PostReaderModal, {
      post: structured,
      creators: [creator],
      channels: [],
    });

    expect(html).toContain('assets.example/ep.mp3');
  });
});

describe('PostCard reader entry', () => {
  const rssPost: Post = {
    id: 'rss_1',
    creatorId: 'creator_1',
    channelId: 'rss:daily',
    platform: 'rss',
    title: '2026-09-08',
    content: 'AI 早报正文。'.repeat(30),
    mediaList: [],
    originalUrl: 'https://daily.juya.uk/2026/09/08',
    publishedAt: Date.UTC(2026, 8, 8),
    fetchedAt: Date.now(),
    isRead: 0,
  };

  async function renderCard(post: Post) {
    return render(PostCard, { post, creators: [creator], channels: [] });
  }

  it('offers the reader on every RSS card', async () => {
    // RSS bodies are articles, so the entry must not depend on the overflow
    // measurement (which cannot run without a layout engine, and mis-measured
    // while the clamp is applied). The user reported the button simply missing.
    const html = await renderCard(rssPost);
    expect(html).toContain('展开全文');
  });

  it('does not offer the reader on a short caption card', async () => {
    // Captions are not articles; a button on every fitting card would be noise.
    // The SSR environment reports no layout, so the measurement says "fits".
    const html = await renderCard({
      ...rssPost,
      platform: 'twitter',
      content: '短推文',
    });
    expect(html).not.toContain('展开全文');
  });

  it('clamps the RSS preview rather than inlining the whole article', async () => {
    // The card stays a preview on purpose: a 4000-character article at ~410px of
    // column width is unreadable and skews the masonry columns.
    const html = await renderCard(rssPost);
    expect(html).toContain('line-clamp-8');
  });
});

describe('DevLogModal renders', () => {
  it('renders inside a dialog with its filters and empty state', async () => {
    const html = await render(DevLogModal, {});
    expect(html).toContain('role="dialog"');
    expect(html).toContain('开发者日志');
    expect(html).toContain('全部级别');
    expect(html).toContain('详细模式');
    expect(html).toContain('本次会话暂无日志');
  });
});
