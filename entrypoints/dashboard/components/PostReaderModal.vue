<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { X, ExternalLink, Clock, Bookmark } from 'lucide-vue-next';
import BaseModal from './BaseModal.vue';
import { PLATFORM_REGISTRY, type Channel, type Creator, type Post } from '../../../src/types';
import { createImageErrorRecovery, toSecureMediaUrl } from '../../../src/utils/media';
import { shouldShowTitle, standaloneMedia } from '../../../src/utils/postText';

/**
 * 全宽阅读视图：给长文 / RSS 这类「正文即文章」的动态一个能真正读完的地方。
 *
 * 为什么需要它：瀑布流列宽约 410px，一篇 4000 字的文章铺在列里既难读又会把
 * masonry 的列高彻底拉失衡。卡片保留预览（截断 + 「展开全文」），完整正文在
 * 这里以受限宽度（`max-w-3xl` 正文栏）呈现——这是阅读排版与信息流排版的不同要求，
 * 不是同一件事的两种做法。
 *
 * 交互复用 `BaseModal`：焦点圈定、Escape 关闭、背景滚动锁、关闭后焦点恢复都已具备。
 * 与「点整张卡片进入阅读」不同，本视图只由卡片上的显式按钮触发，不会误触。
 */
const props = defineProps<{
  post: Post;
  creators: Creator[];
  channels: Channel[];
  bookmarked?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  bookmark: [post: Post];
  media: [media: { url: string; originalUrl?: string; type: string; title?: string }];
}>();

const secure = toSecureMediaUrl;

const creator = computed(() => props.creators.find((c) => c.id === props.post.creatorId));
const channel = computed(() => props.channels.find((c) => c.id === props.post.channelId));
const authorName = computed(() => creator.value?.name || '未知创作者');
const platformName = computed(
  () => PLATFORM_REGISTRY[props.post.platform]?.name || props.post.platform,
);
const avatar = computed(
  () => creator.value?.avatar || channel.value?.avatarUrl || props.post.authorMeta?.avatar || '',
);
const isBookmarked = computed(() => Boolean(props.post.isBookmarked || props.bookmarked));
const showTitle = computed(() => shouldShowTitle(props.post));
const readerMedia = computed(() => standaloneMedia(props.post));

/**
 * Recovery for an article image that fails to load.
 *
 * The article's images are plain `<img>` tags inside `v-html`, so they cannot
 * carry the `@error` handler the card's own media uses — without this they would
 * be the one kind of image in the app with no fallback at all. The listener is
 * registered in the capture phase because `error` from an `<img>` does not bubble.
 */
const articleRef = ref<HTMLElement | null>(null);
const recoverArticleImage = createImageErrorRecovery();

onMounted(() => {
  articleRef.value?.addEventListener('error', recoverArticleImage, true);
});

onBeforeUnmount(() => {
  articleRef.value?.removeEventListener('error', recoverArticleImage, true);
});

const formatDate = (timestamp: number) => {
  if (!timestamp) return '未知时间';
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return date.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
</script>

<template>
  <BaseModal
    overlay-class="bg-black/50 backdrop-blur-xs flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
    @close="emit('close')"
  >
    <div class="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[90vh]">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 p-5 pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-800 shrink-0 flex items-center justify-center text-sm font-bold text-indigo-600 overflow-hidden border border-slate-200 dark:border-slate-700">
            <img v-if="avatar" :src="secure(avatar)" referrerpolicy="no-referrer" class="w-full h-full object-cover" />
            <span v-else>{{ authorName.slice(0, 1) }}</span>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-bold text-sm text-slate-900 dark:text-white truncate">{{ authorName }}</span>
              <span
                :class="PLATFORM_REGISTRY[post.platform]?.badgeBg || 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'"
                class="px-1.5 py-0.2 rounded text-[10px] font-semibold border shrink-0"
              >{{ platformName }}</span>
            </div>
            <div class="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5">
              <Clock class="w-3 h-3" />
              <span>{{ formatDate(post.publishedAt) }}</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            :title="isBookmarked ? '取消收藏' : '收藏'"
            class="p-2 rounded-lg transition-colors cursor-pointer"
            :class="isBookmarked ? 'text-amber-500 bg-amber-50 dark:bg-amber-500/20' : 'text-slate-400 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-800'"
            @click="emit('bookmark', post)"
          >
            <Bookmark class="w-4 h-4" :class="{ 'fill-amber-500 text-amber-500': isBookmarked }" />
          </button>
          <a
            :href="post.originalUrl"
            target="_blank"
            title="打开原帖"
            class="p-2 rounded-lg text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <ExternalLink class="w-4 h-4" />
          </a>
          <button
            type="button"
            class="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            aria-label="关闭"
            @click="emit('close')"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Body: the reason this view exists — full text at a readable measure. -->
      <div class="p-5 sm:p-7 overflow-y-auto flex-1">
        <h2
          v-if="showTitle"
          class="font-bold text-lg sm:text-xl text-slate-900 dark:text-white leading-snug mb-4"
        >{{ post.title }}</h2>

        <!-- Structured article: headings, paragraphs and images where the author
             put them. Sanitized at parse time (`sanitizeHtml.ts`), so `v-html` is
             safe here, and `.article-body` supplies the reading typography —
             which is the whole point of a dedicated view for long text. -->
        <div
          v-if="post.contentHtml"
          ref="articleRef"
          class="article-body text-sm sm:text-[15px] text-slate-700 dark:text-slate-200"
          v-html="post.contentHtml"
        ></div>

        <!-- Plain-text body: `whitespace-pre-wrap` preserves the feed's own line
             breaks, and `break-words` keeps long URLs from overflowing. -->
        <div
          v-else
          class="text-sm sm:text-[15px] text-slate-700 dark:text-slate-200 leading-[1.8] whitespace-pre-wrap break-words"
        >{{ post.content }}</div>

        <!-- Standalone media: only what the article body does not already show.
             When the structured article renders, its images are already in place
             — listing them again below is exactly the duplication this view
             exists to remove. Enclosures (audio/video) are never inline, so they
             still belong here. -->
        <div v-if="readerMedia.length" class="mt-6 space-y-3">
          <div
            v-for="(media, index) in readerMedia"
            :key="index"
            class="rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center"
          >
            <img
              v-if="media.type === 'image'"
              :src="secure(media.originalUrl || media.previewUrl)"
              referrerpolicy="no-referrer"
              loading="lazy"
              class="max-w-full h-auto max-h-[70vh] object-contain cursor-zoom-in"
              @click="emit('media', { url: secure(media.originalUrl || media.previewUrl), originalUrl: post.originalUrl, type: media.type, title: post.title })"
            />
            <video
              v-else-if="media.type === 'video'"
              :src="media.originalUrl || media.previewUrl"
              :poster="media.previewUrl"
              controls
              class="max-w-full h-auto max-h-[70vh]"
            ></video>
            <audio v-else :src="media.originalUrl || media.previewUrl" controls class="w-full p-3"></audio>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
        <span class="text-[11px] text-slate-400">{{ platformName }} · 全文已完整加载</span>
        <a
          :href="post.originalUrl"
          target="_blank"
          class="flex items-center gap-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
        >
          <span>原文</span>
          <ExternalLink class="w-3.5 h-3.5" />
        </a>
      </div>
    </div>
  </BaseModal>
</template>
