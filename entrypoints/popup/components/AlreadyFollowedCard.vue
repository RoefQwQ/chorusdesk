<script setup lang="ts">
import { Check } from 'lucide-vue-next';
import type { Channel, Creator } from '../../../src/types';

/**
 * The "already followed" state: purely informational.
 *
 * It used to carry a 「查看动态」 button that called the same `openDashboard` as the
 * popup header — the same action twice, one of them under a label promising
 * something it did not do (it opens the dashboard, not that creator's feed). The
 * header button is the one entry point for the dashboard, in every state.
 */
defineProps<{
  existingChannel: Channel;
  existingCreator: Creator | null;
}>();
</script>

<template>
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
  </div>
</template>
