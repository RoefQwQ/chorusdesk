<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { Bookmark, ChevronRight, Clock, ExternalLink, Video, ImageOff, Image as ImageIcon, Maximize2, Repeat2, Trash2 } from 'lucide-vue-next';
import { PLATFORM_REGISTRY, type Channel, type Creator, type Post } from '../../../src/types';
import { toSecureMediaUrl, proxyImage, isImageFailed, markImageFailed } from '../../../src/utils/media';
import { imageCacheService } from '../../../src/services/imageCache';
import { recordMediaProbe } from '../../../src/utils/mediaProbeLog';
import { shouldShowTitle, showsFullBody, standaloneMedia } from '../../../src/utils/postText';
import { toEpochMs } from '../../../src/utils/timestamp';

const props = withDefaults(defineProps<{
  post: Post;
  creators: Creator[];
  channels: Channel[];
  bookmarked?: boolean;
  /** Mark the post read automatically once visible ~600ms (feed browsing). */
  autoRead?: boolean;
}>(), { bookmarked: false, autoRead: false });

const emit = defineEmits<{
  bookmark: [post: Post];
  delete: [post: Post];
  read: [post: Post];
  media: [media: { url: string; originalUrl?: string; type: string; title?: string }];
  avatarError: [url: string];
  openReader: [post: Post];
}>();

const isBookmarked = ref(Boolean(props.post.isBookmarked || props.bookmarked));
watch(() => [props.post.isBookmarked, props.bookmarked], () => {
  isBookmarked.value = Boolean(props.post.isBookmarked || props.bookmarked);
});

const creator = computed(() => props.creators.find(c => c.id === props.post.creatorId));
const channel = computed(() => props.channels.find(c => c.id === props.post.channelId));
const authorName = computed(() => creator.value?.name || '未知创作者');
const channelName = computed(() => channel.value?.displayName || channel.value?.accountId || props.post.platform);
const avatar = computed(() => creator.value?.avatar || channel.value?.avatarUrl || props.post.authorMeta?.avatar || '');
const label = computed(() => props.post.channelLabel || channel.value?.label);
const isRepost = computed(() => props.post.isRepost || props.post.content?.startsWith('RT @') || props.post.content?.includes('//转发自'));
const secure = toSecureMediaUrl;

/**
 * Heading presentation.
 *
 * `title` is body-derived on Twitter / Douyin / Xiaohongshu, so both fields
 * carried the same sentence and the card printed it twice.
 */
const showTitle = computed(() => shouldShowTitle(props.post));

/**
 * RSS shows a taller preview: its body is the content, not a caption.
 */
const fullBody = computed(() => showsFullBody(props.post.platform));

/**
 * Media shown in the card's own media block.
 *
 * A structured article already renders its images inline in the reader, so the
 * card must not list them again — on a real feed that meant a 23-image article
 * became a "+17" gallery of broken placeholders under the text (the images could
 * not load at all at the time). Photo posts, which have no article body, keep
 * their gallery because there the images are the post.
 */
const cardMedia = computed(() => standaloneMedia(props.post));

/**
 * A post whose only media is a video.
 *
 * Extracted because two places need the same answer — the thumbnail and the footer
 * link — and they must not drift: for a video the footer's 「原文」 becomes 「视频动态」,
 * which is only correct if the post really is one (2026-09-11).
 */
const isSingleVideo = computed(() => props.post.mediaList.length === 1 && props.post.mediaList[0].type === 'video');

/**
 * The card shows a preview; long text opens in the reader.
 *
 * `bodyOverflows` is measured rather than guessed from a character count: the
 * clamp is applied in CSS, so only the rendered box knows whether anything was
 * actually cut. The「展开全文」affordance appears only when it is needed, which is
 * what keeps it meaningful instead of a permanent fixture on every card.
 */
const bodyEl = ref<HTMLElement | null>(null);
const bodyOverflows = ref(false);

/**
 * Whether to offer the full-text reader.
 *
 * RSS is offered unconditionally: its body *is* the article, and the card
 * deliberately shows only a preview, so the entry is never noise there. That
 * also removes the dependency on a runtime measurement for the one case where
 * losing it matters most.
 *
 * Every other platform's body is a caption, where the button would be clutter
 * on the (common) cards that fit — so it stays gated on the measurement.
 */
const showExpand = computed(() => bodyOverflows.value || fullBody.value);

/**
 * Measure whether the clamped body actually hides text.
 *
 * Reading `scrollHeight` while the element is clamped does not work: Tailwind's
 * `line-clamp-*` renders through `display: -webkit-box`, a layout mode where the
 * box's scroll height collapses to its clamped height — so every card measured
 * as "fits" and the「展开全文」affordance never appeared. The clamp is therefore
 * lifted inline for the duration of the measurement and restored immediately
 * (synchronously, so no paint observes the unclamped state).
 */
function measureBodyOverflow() {
  const el = bodyEl.value;
  if (!el) return;

  const clampedHeight = el.clientHeight;
  const prevDisplay = el.style.display;
  const prevClamp = el.style.getPropertyValue('line-clamp');
  const prevWebkitClamp = el.style.getPropertyValue('-webkit-line-clamp');
  const prevOverflow = el.style.overflow;

  el.style.display = 'block';
  el.style.setProperty('line-clamp', 'unset');
  el.style.setProperty('-webkit-line-clamp', 'unset');
  el.style.overflow = 'visible';
  const fullHeight = el.scrollHeight;

  el.style.display = prevDisplay;
  el.style.setProperty('line-clamp', prevClamp);
  el.style.setProperty('-webkit-line-clamp', prevWebkitClamp);
  el.style.overflow = prevOverflow;

  // `+2` absorbs sub-pixel rounding, which would otherwise report overflow for
  // text that fits exactly.
  bodyOverflows.value = fullHeight > clampedHeight + 2;
}

onMounted(() => {
  void nextTick(() => measureBodyOverflow());
});

watch(
  () => [props.post.content, props.post.id],
  () => {
    bodyOverflows.value = false;
    void nextTick(() => measureBodyOverflow());
  },
);

// Map of resolved image URLs (local disk blob URL takes priority over remote URL)
const localMediaUrls = ref<Record<string, string>>({});

/**
 * Media keys whose disk lookup has finished (hit or miss).
 *
 * The `<img>` is not rendered until this is set, so a card never starts a
 * network request for a file that is already on disk and then has it thrown
 * away when the probe answers — the browser aborts an in-flight image load the
 * moment `src` changes, so the old behaviour wasted a request per cached image
 * and left the placeholder up until the probe resolved.
 */
const mediaProbed = ref<Record<string, boolean>>({});

// Pre-initialize mediaFailedMap with already known failed URLs
const mediaFailedMap = ref<Record<string, boolean>>({});

// Helper to check if media is failed either locally or globally
function isMediaFailed(url?: string): boolean {
  if (!url) return true;
  // If we have a local cached URL, it's definitely NOT failed!
  if (localMediaUrls.value[url]) return false;
  return Boolean(mediaFailedMap.value[url] || isImageFailed(url));
}

// Get best available URL for a media item (local disk blob URL > network URL)
function getMediaDisplayUrl(url: string): string {
  if (!url) return '';
  return localMediaUrls.value[url] || secure(url);
}
// Viewport auto-read: cards are display-only (the design has no clickable
// card surface — media clicks, bookmark and delete all stop propagation), so
// a card counts as seen the moment it enters the viewport. Unread rows are
// then purely "not scrolled to yet", which is exactly what the toolbar
// badge should report.
const cardRoot = ref<HTMLElement | null>(null);
let readObserver: IntersectionObserver | null = null;

onMounted(() => {
  if (!props.autoRead || props.post.isRead) return;
  if (typeof IntersectionObserver === 'undefined') return;
  const rootEl = cardRoot.value;
  if (!rootEl) return;
  readObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      readObserver?.disconnect();
      readObserver = null;
      emit('read', props.post);
    },
    // Any visible sliver counts: a card edge on screen was scrolled past.
    { threshold: 0 },
  );
  readObserver.observe(rootEl);
});

onBeforeUnmount(() => {
  readObserver?.disconnect();
  readObserver = null;
});

// Check local disk before the image loads, but only once the card is near the
// viewport.
//
// Probing on mount meant every card of a 100+ item feed walked the filesystem at
// once, even the ones thousands of pixels below the fold whose images could not
// be seen yet. Each probe was fast (measured 0-390ms) but the queue was not: the
// last cards waited ~3.7s, and because the `<img>` is gated on this probe their
// images appeared that late. The browser's own `loading="lazy"` already defers
// the network request; the probe has to follow the same rule or it becomes the
// bottleneck it was meant to avoid.
let mediaProbeObserver: IntersectionObserver | null = null;

async function probeMedia(): Promise<void> {
  // `cardMedia`, not `post.mediaList`: a structured article's images render
  // inline in the reader, so probing them here would walk the filesystem for
  // media this card never shows.
  if (cardMedia.value.length === 0) return;

  const startedAt = performance.now();
  let hits = 0;

  // Probe every item, then release the `<img>`s together: a per-item release
  // would re-trigger layout for each answer.
  await Promise.all(cardMedia.value.map(async (item, i) => {
    const original = item.previewUrl || item.originalUrl;
    if (!original) return;
    try {
      const localUrl = await imageCacheService.getLocalCachedMediaUrl({
        creatorName: authorName.value,
        platform: props.post.platform,
        postId: props.post.id,
        publishedAt: props.post.publishedAt,
        mediaIndex: i,
        mediaUrl: original,
      });
      if (localUrl) {
        localMediaUrls.value[original] = localUrl;
        delete mediaFailedMap.value[original];
        hits++;
      }
    } catch {
      // Local cache miss is expected on first view; fall through to network.
    }
  }));

  for (const item of cardMedia.value) {
    const key = item.previewUrl || item.originalUrl;
    if (key) mediaProbed.value[key] = true;
  }

  // One line per burst, not per card: the per-card line above made the developer
  // log 68% noise (measured: 102 of 150 lines), which is how a useful window
  // becomes hard to find. See `mediaProbeLog.ts`.
  recordMediaProbe(
    cardMedia.value.length,
    hits,
    Math.round(performance.now() - startedAt),
    props.post.platform,
  );
}

onMounted(() => {
  if (cardMedia.value.length === 0) return;

  // No observer support (or no element yet): a card that cannot be observed must
  // still get its probe, so fall back to doing it immediately.
  if (typeof IntersectionObserver === 'undefined' || !cardRoot.value) {
    void probeMedia();
    return;
  }

  mediaProbeObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      mediaProbeObserver?.disconnect();
      mediaProbeObserver = null;
      void probeMedia();
    },
    // Generous margin: start the probe well before the card is on screen, so a
    // cached image is ready by the time it scrolls in.
    { rootMargin: '800px 0px' },
  );
  mediaProbeObserver.observe(cardRoot.value);
});

onBeforeUnmount(() => {
  mediaProbeObserver?.disconnect();
  mediaProbeObserver = null;
});

const avatarFailed = ref(false);

function handleAvatarError(url: string) {
  avatarFailed.value = true;
  markImageFailed(url);
  emit('avatarError', url);
}

async function handleMediaError(e: Event, originalUrl?: string, mediaIndex: number = 0) {
  const target = e.target as HTMLImageElement;
  if (!target || !originalUrl) return;

  // IMMEDIATELY hide the broken image element so the browser's native broken icon NEVER flashes
  target.style.opacity = '0';
  target.style.visibility = 'hidden';

  // 1. Try reading from local disk cache first
  try {
    const localUrl = await imageCacheService.getLocalCachedMediaUrl({
      creatorName: authorName.value,
      platform: props.post.platform,
      postId: props.post.id,
      publishedAt: props.post.publishedAt,
      mediaIndex,
      mediaUrl: originalUrl,
    });
    if (localUrl) {
      localMediaUrls.value[originalUrl] = localUrl;
      target.src = localUrl;
      target.style.opacity = '';
      target.style.visibility = '';
      delete mediaFailedMap.value[originalUrl];
      return;
    }
  } catch {
    // Cache miss: fall through to the retry ladder below.
  }

  const retryCount = Number(target.dataset.retryCount || 0);
  if (retryCount >= 1 || isImageFailed(originalUrl)) {
    markImageFailed(originalUrl);
    mediaFailedMap.value[originalUrl] = true;
    return;
  }
  target.dataset.retryCount = String(retryCount + 1);

  try {
    const proxiedDataUrl = await proxyImage(originalUrl);
    if (proxiedDataUrl) {
      target.src = proxiedDataUrl;
      target.style.opacity = '';
      target.style.visibility = '';

      // Auto save successfully proxied image to local disk cache in background
      imageCacheService.cacheMediaItem({
        creatorName: authorName.value,
        platform: props.post.platform,
        postId: props.post.id,
        publishedAt: props.post.publishedAt,
        mediaIndex,
        mediaUrl: originalUrl,
      }).catch(() => {});

      return;
    }
  } catch {
    // Proxy also failed: mark permanently failed below.
  }

  markImageFailed(originalUrl);
  mediaFailedMap.value[originalUrl] = true;
}

// When user image loads successfully on web, opportunistically cache it to disk
function handleMediaLoad(originalUrl: string, mediaIndex: number = 0) {
  if (!originalUrl || localMediaUrls.value[originalUrl]) return;
  imageCacheService.cacheMediaItem({
    creatorName: authorName.value,
    platform: props.post.platform,
    postId: props.post.id,
    publishedAt: props.post.publishedAt,
    mediaIndex,
    mediaUrl: originalUrl,
  }).then((cachedUrl) => {
    if (cachedUrl) {
      localMediaUrls.value[originalUrl] = cachedUrl;
    }
  }).catch(() => {});
}

const formatTime = (timestamp: number) => {
  const ms = toEpochMs(timestamp);
  if (ms === null) return '未知时间';
  const date = new Date(ms);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return date.toLocaleDateString('zh-CN');
};

const openMedia = (url: string, type: string) => emit('media', { url, originalUrl: props.post.originalUrl, type, title: props.post.title });

function openVideoPost(url?: string) {
  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else if (props.post.mediaList?.[0]?.previewUrl) {
    openMedia(props.post.mediaList[0].previewUrl, 'video');
  }
}

function toggleBookmark() {
  isBookmarked.value = !isBookmarked.value;
  emit('bookmark', props.post);
}
</script>
<template>
  <article
    ref="cardRoot"
    class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 overflow-hidden shadow-xs hover:shadow-xl hover:-translate-y-1 transition-all duration-300 ease-out flex flex-col group/card will-change-transform"
    :class="isBookmarked ? 'ring-1 ring-amber-500/30' : (post.isRead ? '' : 'ring-1 ring-indigo-400/40 dark:ring-indigo-600/50')"
  >
    <div class="p-4 border-b border-slate-100 dark:border-slate-800/60 flex items-center justify-between">
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 shrink-0 flex items-center justify-center text-xs font-bold text-indigo-600 overflow-hidden border border-slate-200 dark:border-slate-700 shadow-2xs group-hover/card:scale-105 transition-transform duration-200">
          <img v-if="avatar && !avatarFailed" :src="secure(avatar)" referrerpolicy="no-referrer" class="w-full h-full object-cover" @error="handleAvatarError(avatar)" />
          <span v-else>{{ authorName.slice(0, 1) }}</span>
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <h4 class="font-bold text-xs text-slate-900 dark:text-white leading-tight truncate group-hover/card:text-indigo-600 dark:group-hover/card:text-indigo-400 transition-colors">{{ authorName }}</h4>
            <span v-if="label" class="px-1.5 py-0.2 rounded text-[9px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-slate-700/80 shrink-0">{{ label }}</span>
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5 min-w-0">
            <span :class="PLATFORM_REGISTRY[post.platform]?.badgeBg || 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'" class="px-1.5 py-0.2 rounded text-[9px] font-semibold border shrink-0 transition-transform hover:scale-105">{{ PLATFORM_REGISTRY[post.platform]?.name || post.platform }}</span>
            <span v-if="isRepost" class="px-1.5 py-0.2 rounded text-[9px] font-medium bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40 shrink-0 flex items-center gap-0.5"><Repeat2 class="w-2.5 h-2.5" />转发</span>
            <span class="truncate max-w-[100px] text-slate-500 dark:text-slate-400">@{{ channelName }}</span><span>•</span>
            <span class="flex items-center gap-0.5 shrink-0"><Clock class="w-2.5 h-2.5" />{{ formatTime(post.publishedAt) }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button type="button" @click.stop="toggleBookmark" :title="isBookmarked ? '取消收藏' : '收藏'" class="p-1.5 rounded-lg transition-all duration-150 cursor-pointer active:scale-90" :class="isBookmarked ? 'text-amber-500 bg-amber-50 dark:bg-amber-500/20 dark:text-amber-400' : 'text-slate-400 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-800'"><Bookmark class="w-3.5 h-3.5" :class="{ 'fill-amber-500 text-amber-500': isBookmarked }" /></button>
        <button type="button" @click.stop="emit('delete', post)" title="删除动态" class="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-all duration-150 cursor-pointer active:scale-90"><Trash2 class="w-3.5 h-3.5" /></button>
        <a :href="post.originalUrl" target="_blank" title="打开原帖" class="text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-150 cursor-pointer active:scale-90 shrink-0"><ExternalLink class="w-3.5 h-3.5" /></a>
      </div>
    </div>

    <div class="p-4 flex-1 space-y-3">
      <h5 v-if="showTitle" class="font-bold text-sm text-slate-900 dark:text-white leading-snug line-clamp-2 tracking-tight">{{ post.title }}</h5>
      <div v-if="post.content">
        <!-- The card is a preview by design: a 4000-character article at ~410px
             of column width is unreadable and skews the masonry columns. The
             full text lives in the reader, one explicit click away. RSS gets a
             taller preview because its body is the content, not a caption. -->
        <p
          ref="bodyEl"
          class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap leading-relaxed"
          :class="fullBody ? 'line-clamp-8' : 'line-clamp-4'"
        >{{ post.content }}</p>
        <button
          v-if="showExpand"
          type="button"
          class="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 border border-indigo-200/70 dark:border-indigo-800/70 transition-colors cursor-pointer"
          title="在阅读视图中打开全文"
          @click.stop="emit('openReader', post)"
        >
          <Maximize2 class="w-3 h-3" />
          <span>展开全文</span>
        </button>
      </div>
      <div v-if="cardMedia.length" class="pt-1">
        <!-- Single Video -->
        <div
          v-if="isSingleVideo"
          @click.stop="openVideoPost(post.originalUrl)"
          class="relative aspect-video rounded-xl overflow-hidden bg-slate-900 cursor-pointer group/vid flex items-center justify-center shadow-xs hover:shadow-md transition-shadow"
          title="在新标签页中打开并观看原视频"
        >
          <img
            v-if="!isMediaFailed(post.mediaList[0].previewUrl) && mediaProbed[post.mediaList[0].previewUrl]"
            :src="secure(post.mediaList[0].previewUrl)"
            referrerpolicy="no-referrer"
            loading="lazy"
            class="w-full h-full object-cover opacity-95 group-hover/vid:scale-103 transition-transform duration-300"
            @error="handleMediaError($event, post.mediaList[0].previewUrl)"
          />

          <!-- Subtle Hover Overlay Prompt -->
          <div class="absolute inset-0 bg-black/25 opacity-0 group-hover/vid:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
            <span class="px-3.5 py-1.5 rounded-full bg-black/75 backdrop-blur-md text-white text-xs font-medium flex items-center gap-1.5 shadow-lg border border-white/15 scale-95 group-hover/vid:scale-100 transition-transform">
              <span>在源站观看完整视频</span>
              <ExternalLink class="w-3.5 h-3.5 text-indigo-300" />
            </span>
          </div>
        </div>

        <!-- Single Image -->
        <div v-else-if="post.mediaList.length === 1">
          <!-- Elegant Fallback Card when image is restricted / unavailable -->
          <div
            v-if="isMediaFailed(post.mediaList[0].previewUrl)"
            class="w-full py-8 px-5 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-gradient-to-b from-slate-50 to-slate-100/70 dark:from-slate-800/80 dark:to-slate-900 flex flex-col items-center justify-center text-center select-none"
          >
            <div class="w-10 h-10 rounded-2xl bg-white dark:bg-slate-800 shadow-xs border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-center text-slate-400 dark:text-slate-400 mb-2.5">
              <ImageOff class="w-5 h-5 stroke-[1.75]" />
            </div>
            <p class="text-xs font-semibold text-slate-700 dark:text-slate-200">原图暂无法直接预览</p>
            <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1 max-w-[240px] leading-relaxed">
              源站 CDN 访问受限或动态时间较早，可直接在原帖中查看完整内容
            </p>
            <a
              :href="post.originalUrl"
              target="_blank"
              @click.stop
              class="mt-3.5 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 border border-slate-200 dark:border-slate-700 shadow-2xs hover:shadow-xs hover:border-indigo-300 dark:hover:border-indigo-700 transition-all cursor-pointer"
            >
              <span>直达原帖查看图片</span>
              <ExternalLink class="w-3.5 h-3.5" />
            </a>
          </div>

          <!-- Normal Single Image Display -->
          <div
            v-else
            @click.stop="openMedia(localMediaUrls[post.mediaList[0].previewUrl] || post.mediaList[0].previewUrl, 'image')"
            class="relative min-h-[160px] max-h-[460px] rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800 cursor-zoom-in group/img flex items-center justify-center"
          >
            <img
              v-if="mediaProbed[post.mediaList[0].previewUrl]"
              :src="getMediaDisplayUrl(post.mediaList[0].previewUrl)"
              referrerpolicy="no-referrer"
              loading="lazy"
              class="w-full h-full max-h-[460px] object-cover group-hover/img:scale-103 transition-transform duration-300 ease-out"
              @load="handleMediaLoad(post.mediaList[0].previewUrl, 0)"
              @error="handleMediaError($event, post.mediaList[0].previewUrl, 0)"
            />
            <!-- Disk lookup in flight: same box, so the card does not jump when
                 the image arrives. -->
            <span v-else class="text-slate-300 dark:text-slate-600" aria-hidden="true">
              <ImageIcon class="w-6 h-6 animate-pulse" />
            </span>
          </div>
        </div>

        <!-- Gallery Grid (2 or more images) -->
        <div v-else :class="post.mediaList.length === 2 ? 'grid grid-cols-2 gap-2 aspect-[16/11]' : post.mediaList.length <= 4 ? 'grid grid-cols-2 gap-1.5 aspect-square' : 'grid grid-cols-3 gap-1.5'">
          <div
            v-for="(media, index) in post.mediaList.slice(0, post.mediaList.length > 4 ? 6 : undefined)"
            :key="index"
            @click.stop="!isMediaFailed(media.previewUrl) && openMedia(localMediaUrls[media.previewUrl] || media.originalUrl || media.previewUrl, media.type)"
            class="relative aspect-square rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center"
            :class="isMediaFailed(media.previewUrl) ? 'border border-slate-200/80 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80' : 'cursor-zoom-in group/gallery'"
          >
            <!-- Miniature Fallback if thumbnail is unavailable -->
            <div
              v-if="isMediaFailed(media.previewUrl)"
              class="w-full h-full flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 p-1 text-center select-none"
              title="图片无法直接加载，可在原帖查看"
            >
              <ImageOff class="w-4 h-4 stroke-[1.75]" />
              <span class="text-[9px] mt-1 text-slate-400 dark:text-slate-500 scale-90">预览受限</span>
            </div>
            <!-- Normal Thumbnail -->
            <template v-else>
              <img
                v-if="mediaProbed[media.previewUrl]"
                :src="getMediaDisplayUrl(media.previewUrl)"
                referrerpolicy="no-referrer"
                loading="lazy"
                class="w-full h-full object-cover group-hover/gallery:scale-105 transition-transform duration-300 ease-out"
                @load="handleMediaLoad(media.previewUrl, index)"
                @error="handleMediaError($event, media.previewUrl, index)"
              />
              <ImageIcon v-else class="w-4 h-4 text-slate-300 dark:text-slate-600 animate-pulse" aria-hidden="true" />
              <span
                v-if="index === 5 && post.mediaList.length > 6"
                class="absolute inset-0 bg-black/60 backdrop-blur-2xs flex items-center justify-center text-white font-bold text-xs"
              >
                +{{ post.mediaList.length - 6 }}
              </span>
            </template>
          </div>
        </div>
      </div>
    </div>
    <div class="px-4 py-2.5 bg-slate-50/80 dark:bg-slate-950/50 border-t border-slate-100 dark:border-slate-800/80 text-[11px] text-slate-400 dark:text-slate-400 flex items-center justify-between">
      <span>{{ formatTime(post.fetchedAt) }} 同步</span>
      <a
        :href="post.originalUrl"
        target="_blank"
        class="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 font-medium group/link transition-colors"
      >
        <!-- For a video the entry point lives here, always visible, instead of as a
             badge on top of the thumbnail where it overlapped the hover prompt. Same
             destination (`originalUrl`); the label differs because 「原文」 understates
             what the click does for a video. -->
        <Video v-if="isSingleVideo" class="w-3 h-3" />
        <span>{{ isSingleVideo ? '视频动态' : '原文' }}</span>
        <ChevronRight class="w-3 h-3 group-hover/link:translate-x-0.5 transition-transform" />
      </a>
    </div>
  </article>
</template>
