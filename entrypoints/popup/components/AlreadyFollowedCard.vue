<script setup lang="ts">
import { Check } from 'lucide-vue-next';
import type { Channel, Creator } from '../../../src/types';

defineProps<{
  existingChannel: Channel;
  existingCreator: Creator | null;
}>();

const emit = defineEmits<{
  openDashboard: [];
}>();
</script>

<template>
  <!-- If Already Added -->
  <div
    class="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-xl text-emerald-800 dark:text-emerald-200"
  >
    <div class="flex items-center gap-1.5 font-semibold text-xs mb-1">
      <Check class="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
      <span>已关注</span>
    </div>
    <p class="text-[11px] text-emerald-700 dark:text-emerald-300">
      已归集到 <strong>{{ existingCreator?.name || '未知创作者' }}</strong>
    </p>
    <button
      @click="emit('openDashboard')"
      class="mt-2.5 w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors cursor-pointer"
    >
      查看动态
    </button>
  </div>
</template>
