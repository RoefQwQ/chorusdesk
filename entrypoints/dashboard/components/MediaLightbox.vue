<script setup lang="ts">
import { ExternalLink, X } from 'lucide-vue-next';
import { toSecureMediaUrl, proxyImage } from '../../../src/utils/media';
import BaseModal from './BaseModal.vue';

defineProps<{ media: { url: string; originalUrl?: string; type: string; title?: string } }>();
const emit = defineEmits<{ close: [] }>();
const secure = toSecureMediaUrl;

async function handleImgError(e: Event, originalUrl?: string) {
  const target = e.target as HTMLImageElement;
  if (!target || !originalUrl) return;
  if (target.dataset.proxied) return;
  target.dataset.proxied = 'true';

  const proxiedDataUrl = await proxyImage(originalUrl);
  if (proxiedDataUrl) {
    target.src = proxiedDataUrl;
  }
}
</script>
<template>
  <BaseModal
    overlay-class="bg-black/92 backdrop-blur-md flex flex-col justify-between p-4 sm:p-6"
    @close="emit('close')"
  >
    <div class="flex items-center justify-between text-white/80">
      <span class="text-xs truncate max-w-xl">{{ media.title || '媒体大图查看' }}</span>
      <div class="flex items-center gap-3">
        <a v-if="media.originalUrl" :href="media.originalUrl" target="_blank" class="flex items-center gap-1 text-xs text-indigo-400 hover:underline" @click.stop>
          <span>访问原帖</span><ExternalLink class="w-3.5 h-3.5" />
        </a>
        <button @click="emit('close')" class="p-1.5 rounded-full hover:bg-white/10 text-white cursor-pointer" title="按 ESC 或点按关闭"><X class="w-5 h-5" /></button>
      </div>
    </div>
    <div class="flex-1 flex items-center justify-center p-2 min-h-0" @click="emit('close')">
      <img :src="secure(media.url)" referrerpolicy="no-referrer" class="max-w-full max-h-[82vh] object-contain rounded-xl shadow-2xl transition-all select-none" @error="handleImgError($event, media.url)" @click.stop />
    </div>
    <div class="text-center text-[11px] text-white/40">点击遮罩或按 ESC 键即可退出大图模式</div>
  </BaseModal>
</template>
