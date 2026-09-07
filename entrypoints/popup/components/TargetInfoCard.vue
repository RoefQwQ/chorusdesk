<script setup lang="ts">
import { computed } from 'vue';
import { ExternalLink } from 'lucide-vue-next';
import { PLATFORM_REGISTRY } from '../../../src/types';
import type { ParsedProfile } from '../../../src/utils/urlParser';
import { toSecureMediaUrl } from '../../../src/utils/media';
import type { AuthorMeta } from '../composables/usePageDetection';

const props = defineProps<{
  parsed: ParsedProfile;
  authorMeta: AuthorMeta;
  displayName: string;
}>();

const platformMeta = computed(() => PLATFORM_REGISTRY[props.parsed.platform]);
</script>

<template>
  <!-- Target Info -->
  <div class="p-3 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xs">
    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-1.5">
        <span
          :class="platformMeta?.badgeBg"
          class="px-2 py-0.5 rounded-full text-[10px] font-semibold border"
        >
          {{ platformMeta?.name }}
        </span>
        <span class="text-slate-400 text-[10px]">已识别</span>
      </div>
      <a
        :href="parsed.cleanUrl"
        target="_blank"
        class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
      >
        <ExternalLink class="w-3.5 h-3.5" />
      </a>
    </div>

    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 flex items-center justify-center font-bold text-sm text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 shadow-2xs">
        <img
          v-if="authorMeta.avatar"
          :src="toSecureMediaUrl(authorMeta.avatar)"
          class="w-full h-full object-cover"
          referrerpolicy="no-referrer"
        />
        <span v-else>{{ (displayName || parsed.accountId).slice(0, 1) }}</span>
      </div>

      <div class="min-w-0 flex-1">
        <div class="font-bold text-slate-800 dark:text-slate-100 text-sm truncate flex items-center gap-1.5">
          <span>{{ displayName || parsed.accountId }}</span>
          <span v-if="authorMeta.name" class="px-1.5 py-0.2 rounded text-[9px] bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 shrink-0">
            页面昵称
          </span>
        </div>
        <div class="text-[11px] text-slate-400 truncate mt-0.5 flex items-center gap-1">
          <span>ID:</span>
          <span class="font-mono text-slate-500 dark:text-slate-400">{{ parsed.accountId }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
