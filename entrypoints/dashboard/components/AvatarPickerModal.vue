<script setup lang="ts">
import { X, CheckCircle2 } from 'lucide-vue-next';
import { PLATFORM_REGISTRY, type Creator, type Channel } from '../../../src/types';
import { toSecureMediaUrl } from '../../../src/utils/media';

defineProps<{
  creator: Creator;
  /** 该创作者绑定的全部平台账号（组件内按 avatarUrl 过滤）。 */
  channels: Channel[];
  /** 当前主头像 URL（已安全化）或空串。 */
  currentAvatar: string;
}>();
const emit = defineEmits<{
  close: [];
  select: [url: string];
}>();
const secure = toSecureMediaUrl;
</script>

<template>
  <div class="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4" @click.self="emit('close')">
    <div class="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 shadow-2xl space-y-4">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
        <div>
          <h3 class="font-bold text-sm text-slate-900 dark:text-white">选择主展示头像</h3>
          <p class="text-[11px] text-slate-400 mt-0.5">{{ creator.name }} · 从已绑定的各平台账号中挑选</p>
        </div>
        <button class="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer" @click="emit('close')">
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="space-y-2 max-h-72 overflow-y-auto pr-1">
        <button
          v-for="ch in channels.filter(item => item.creatorId === creator.id && item.avatarUrl)"
          :key="ch.id"
          class="w-full flex items-center justify-between p-2.5 rounded-xl border transition-all text-left cursor-pointer group"
          :class="currentAvatar === secure(ch.avatarUrl) ? 'bg-indigo-50/60 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700' : 'bg-slate-50/50 dark:bg-slate-800/40 border-slate-200/60 dark:border-slate-700/60 hover:bg-indigo-50/30 dark:hover:bg-slate-800 hover:border-indigo-200'"
          @click="emit('select', ch.avatarUrl!)"
        >
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-full overflow-hidden border border-slate-200 dark:border-slate-700 shrink-0 shadow-2xs">
              <img :src="secure(ch.avatarUrl)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
            </div>
            <div class="min-w-0">
              <div class="font-semibold text-xs text-slate-800 dark:text-slate-200 truncate">
                {{ ch.displayName || ch.accountId }}
              </div>
              <div class="flex items-center gap-1.5 mt-0.5">
                <span :class="PLATFORM_REGISTRY[ch.platform]?.badgeBg" class="px-1.5 py-0.2 rounded text-[9px] font-bold border">
                  {{ PLATFORM_REGISTRY[ch.platform]?.name || ch.platform }}
                </span>
                <span class="text-[10px] text-slate-400 font-mono truncate max-w-[120px]">
                  {{ ch.accountId }}
                </span>
              </div>
            </div>
          </div>

          <div class="shrink-0 ml-2">
            <span v-if="currentAvatar === secure(ch.avatarUrl)" class="flex items-center gap-1 text-[11px] font-bold text-indigo-600 dark:text-indigo-400">
              <CheckCircle2 class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>当前主头像</span>
            </span>
            <span v-else class="text-[10px] text-slate-400 group-hover:text-indigo-600 group-hover:underline">
              设为主头像
            </span>
          </div>
        </button>

        <p v-if="!channels.some(item => item.creatorId === creator.id && item.avatarUrl)" class="text-xs text-slate-400 py-6 text-center">
          当前创作者绑定的账号暂未获取到有效平台头像，点击账号旁的同步按钮拉取最新数据。
        </p>
      </div>

      <div class="pt-2 border-t border-slate-100 dark:border-slate-800 flex justify-end">
        <button
          @click="emit('close')"
          class="px-4 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
        >
          关闭
        </button>
      </div>
    </div>
  </div>
</template>
