<script setup lang="ts">
import { Check, Radio } from 'lucide-vue-next';

defineProps<{
  state: 'idle' | 'syncing' | 'synced' | 'failed';
  message: string;
}>();

const emit = defineEmits<{
  sync: [];
}>();
</script>

<template>
  <div
    class="mt-2.5 p-2 rounded-xl border text-xs flex items-center justify-between gap-2"
    :class="state === 'synced' ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200'"
  >
    <div class="flex items-center gap-1.5 min-w-0">
      <Check v-if="state === 'synced'" class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
      <Radio v-else class="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 animate-pulse" />
      <span class="truncate text-[11px]">
        {{ state === 'synced' ? '已自动从当前页面同步 Rplay 登录凭证' : (state === 'syncing' ? '正在提取登录凭据...' : (message || '检测到 Rplay 页面，可同步登录凭证')) }}
      </span>
    </div>
    <button
      v-if="state !== 'synced'"
      @click="emit('sync')"
      class="shrink-0 px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] font-medium transition-colors cursor-pointer"
    >
      一键同步
    </button>
    <span v-else class="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">✓ 就绪</span>
  </div>
</template>
