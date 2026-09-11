<script setup lang="ts">
import { computed } from 'vue';
import { PLATFORM_REGISTRY, type Platform } from '../../../../src/types';

/**
 * 平台账号徽章：平台色 + 账号数量角标。三种创作者视图（网格 / 列表 /
 * 详细）原先各自内联渲染三份，样式已经出现漂移（字体字号 / 边框阴影不一致），
 * 此组件收敛为单一实现。
 */
const props = defineProps<{
  platform: string;
  /** 该平台下绑定的账号数量；>1 时渲染 xN 角标。 */
  count?: number;
  /** 紧凑样式（网格视图旧样式：text-[9px] + font-bold）。 */
  compact?: boolean;
}>();

const meta = computed(() => PLATFORM_REGISTRY[props.platform as Platform]);
</script>

<template>
  <span
    :class="meta?.badgeBg || 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'"
    class="px-1.5 py-0.5 rounded border flex items-center gap-0.5"
    :title="`${meta?.name || platform}${count !== undefined ? `（${count} 个账号）` : ''}`"
  >
    <span :class="[compact ? 'text-[9px] font-bold' : 'text-[10px] font-medium']">
      {{ meta?.name || platform }}
    </span>
    <span v-if="count !== undefined && count > 1" :class="compact ? 'text-[8px] opacity-75 font-mono' : 'text-[9px] opacity-75'">
      x{{ count }}
    </span>
  </span>
</template>
