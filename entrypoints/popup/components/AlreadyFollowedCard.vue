<script setup lang="ts">
import { Check, Info } from 'lucide-vue-next';
import type { Channel, Creator } from '../../../src/types';

/**
 * The "already followed" state: informational, plus the one thing the user needs
 * to know when the follow succeeded but its first fetch did not.
 *
 * The fetch is delegated to the service worker, and some platforms cannot run
 * there at all (`backgroundSync: false` — douyin and twitter). The worker says so
 * honestly; before this the popup dropped that answer, so the user saw 「已关注」
 * and then an empty feed, with the reason visible only in a console they do not
 * have open. The note below is that answer, in the popup.
 *
 * It used to carry a 「查看动态」 button that called the same `openDashboard` as the
 * popup header — the same action twice, one of them under a label promising
 * something it did not do (it opens the dashboard, not that creator's feed). The
 * header button is the one entry point for the dashboard, in every state.
 */
defineProps<{
  existingChannel: Channel;
  existingCreator: Creator | null;
  /** Why the first fetch did not run; `null` when there is nothing to report. */
  firstSyncError?: string | null;
}>();
</script>

<template>
  <div class="space-y-2">
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

    <!--
      The platform refused the background fetch. Stated plainly and with the next
      step, because 「首次抓取失败」 alone leaves the user with nothing to do —
      and the sync will not retry on its own.
    -->
    <div
      v-if="firstSyncError"
      class="p-2.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 rounded-xl text-[11px] text-amber-800 dark:text-amber-200 leading-relaxed"
    >
      <div class="flex items-start gap-1.5">
        <Info class="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
        <div>
          <div class="font-semibold mb-0.5">首次同步未完成</div>
          <div>{{ firstSyncError }}</div>
          <div class="mt-1 text-amber-700 dark:text-amber-300">
            打开面板后手动同步该账号即可。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
