<script setup lang="ts">
import { computed, ref } from 'vue';
import { X, Trash2, Copy, Bug, Search, RefreshCw } from 'lucide-vue-next';
import BaseModal from './BaseModal.vue';
import AppSelect from './AppSelect.vue';
import { useDevLog } from '../composables/useDevLog';
import type { DevLogLevel } from '../../../src/utils/devLog';

/**
 * 开发者日志面板：读取 `chrome.storage.session` 中的环形缓冲，实时显示
 * 后台 Service Worker 与本页写入的记录。
 *
 * 定位是「不开 devtools 也能自查」：打包后的扩展里 SW 控制台几乎不可达，
 * 而消息拒绝、告警触发、授权拒绝等失败只在那里可见。面板只展示已脱敏的
 * 文本（主机名、计数、错误消息），可直接复制进问题反馈。
 */
const emit = defineEmits<{ close: [] }>();

const {
  visibleEntries,
  levelFilter,
  scopeFilter,
  textFilter,
  verbose,
  scopes,
  counts,
  levels,
  toggleVerbose,
  clearLog,
  copyVisible,
  formatTime,
} = useDevLog();

const copied = ref(false);

const LEVEL_LABEL: Record<DevLogLevel, string> = {
  error: '错误',
  warn: '警告',
  info: '信息',
  debug: '调试',
};

const LEVEL_CLASS: Record<DevLogLevel, string> = {
  error: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900',
  warn: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900',
  info: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  debug: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-900',
};

const levelOptions = computed(() => [
  { value: 'all', label: '全部级别' },
  ...levels.map((l) => ({ value: l, label: `${LEVEL_LABEL[l]}及以上` })),
]);

/** Only scopes actually present, so the filter never offers an empty result. */
const scopeOptions = computed(() => [
  { value: 'all', label: '全部模块' },
  ...scopes.value.map((s) => ({ value: s, label: s })),
]);

async function handleCopy() {
  copied.value = await copyVisible();
  if (copied.value) setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <BaseModal
    overlay-class="bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
    @close="emit('close')"
  >
    <div class="w-full max-w-4xl bg-white dark:bg-slate-900 rounded-3xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-3 max-h-[88vh] flex flex-col">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div>
          <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
            <Bug class="w-4 h-4 text-indigo-500" />
            开发者日志
          </h3>
          <p class="text-[11px] text-slate-400 mt-0.5">
            记录后台消息、同步与授权过程。共 {{ counts.total }} 条（错误 {{ counts.byLevel.error }} · 警告 {{ counts.byLevel.warn }}）；
            仅存于本次浏览器会话，不写入数据库与备份。
          </p>
        </div>
        <button
          type="button"
          @click="emit('close')"
          class="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          aria-label="关闭"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2 shrink-0">
        <div class="relative flex-1 min-w-[180px]">
          <Search class="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            v-model="textFilter"
            type="text"
            placeholder="搜索 scope / 消息 / 详情..."
            class="w-full pl-8 pr-3 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder-slate-400"
          />
        </div>
        <AppSelect
          v-model="levelFilter"
          :options="levelOptions"
          menu-placement="bottom"
          aria-label="按级别过滤"
          button-class="px-2.5 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 text-slate-700 dark:text-slate-200"
        />
        <AppSelect
          v-model="scopeFilter"
          :options="scopeOptions"
          menu-placement="bottom"
          aria-label="按模块过滤"
          button-class="px-2.5 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 text-slate-700 dark:text-slate-200"
        />
        <button
          type="button"
          @click="toggleVerbose"
          class="px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer"
          :class="verbose
            ? 'bg-indigo-600 text-white border-indigo-600'
            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'"
          :title="verbose ? '正在记录调试级明细（含每次请求的主机与耗时）' : '开启后会额外记录调试级明细'"
        >
          详细模式
        </button>
      </div>

      <!-- Entries -->
      <div class="flex-1 overflow-y-auto min-h-[220px] rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
        <p v-if="visibleEntries.length === 0" class="p-6 text-center text-xs text-slate-400">
          {{ counts.total === 0 ? '本次会话暂无日志。执行一次同步或后台任务后再回来查看。' : '当前筛选条件下没有匹配的日志。' }}
        </p>
        <div v-for="entry in visibleEntries" :key="entry.t + entry.scope + entry.message" class="p-2.5 text-xs space-y-0.5">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono text-[10px] text-slate-400">{{ formatTime(entry.t) }}</span>
            <span class="px-1.5 py-0.2 rounded text-[10px] font-medium border" :class="LEVEL_CLASS[entry.level]">
              {{ LEVEL_LABEL[entry.level] }}
            </span>
            <span class="px-1.5 py-0.2 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono">{{ entry.scope }}</span>
            <span class="text-[10px] text-slate-400">{{ entry.source === 'sw' ? '后台' : '页面' }}</span>
          </div>
          <div class="text-slate-700 dark:text-slate-200 break-all">{{ entry.message }}</div>
          <div v-if="entry.detail" class="text-[11px] text-slate-400 break-all whitespace-pre-wrap">{{ entry.detail }}</div>
        </div>
      </div>

      <div class="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 shrink-0">
        <span class="text-[11px] text-slate-400">
          显示 {{ visibleEntries.length }} / {{ counts.total }} 条
        </span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="clearLog"
            class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer transition-colors"
          >
            <Trash2 class="w-3.5 h-3.5" />
            清空
          </button>
          <button
            type="button"
            @click="handleCopy"
            :disabled="visibleEntries.length === 0"
            class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg cursor-pointer transition-colors"
          >
            <Copy v-if="!copied" class="w-3.5 h-3.5" />
            <RefreshCw v-else class="w-3.5 h-3.5" />
            {{ copied ? '已复制' : '复制当前筛选' }}
          </button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>
