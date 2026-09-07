<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  X, History, CheckSquare, Square, Play, StopCircle,
} from 'lucide-vue-next';
import { PLATFORM_REGISTRY, type Creator, type Channel } from '../../../src/types';
import type { DeepSyncStartRequest } from '../types/modal';

const props = defineProps<{
  creator: Creator;
  channels: Channel[];
  /** 运行时状态快照（父层驱动深层同步时推进）。 */
  running: boolean;
  currentStatus: string;
  logs: string[];
  totalNew: number;
  /** “仅原创”复选框默认值（跟随全局 hideReposts 设置）。 */
  defaultOnlyOriginal?: boolean;
  /** 若指定（来自渠道行的“针对该账号深度回溯”），仅预选该渠道。 */
  initialChannelId?: string;
}>();
const emit = defineEmits<{
  close: [];
  start: [request: DeepSyncStartRequest];
  stop: [];
}>();

// Local options (mirror of the former App.vue fields; defaults each open).
const selectedChannels = ref<string[]>([]);
const mode = ref<'count' | 'time'>('count');
const targetCount = ref(50);
const customCount = ref(50);
const timeRange = ref(30);
const onlyOriginal = ref(false);
const resetCursor = ref(false);

watch(
  () => props.creator,
  (creator) => {
    if (!creator) return;
    const chs = props.channels.filter(ch => ch.creatorId === creator.id);
    selectedChannels.value = props.initialChannelId && chs.some(ch => ch.id === props.initialChannelId)
      ? [props.initialChannelId]
      : chs.map(ch => ch.id);
    mode.value = 'count';
    targetCount.value = 50;
    customCount.value = 50;
    timeRange.value = 30;
    onlyOriginal.value = Boolean(props.defaultOnlyOriginal);
    resetCursor.value = false;
  },
  { immediate: true }
);

function toggleChannel(chId: string) {
  if (props.running) return;
  const idx = selectedChannels.value.indexOf(chId);
  if (idx !== -1) {
    selectedChannels.value.splice(idx, 1);
  } else {
    selectedChannels.value.push(chId);
  }
}

function setCountPreset(preset: number) {
  targetCount.value = preset;
  customCount.value = preset;
}

function start() {
  emit('start', {
    channelIds: [...selectedChannels.value],
    mode: mode.value,
    targetCount: targetCount.value,
    timeRange: timeRange.value,
    onlyOriginal: onlyOriginal.value,
    resetCursor: resetCursor.value,
  });
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
  >
    <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-5 animate-scale-up max-h-[90vh] flex flex-col">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-bold border border-indigo-100 dark:border-indigo-900">
            <History class="w-4 h-4" />
          </div>
          <div>
            <h3 class="font-bold text-sm text-slate-900 dark:text-white">
              回溯历史 - {{ creator.name }}
            </h3>
            <p class="text-[11px] text-slate-400">
              获取更早的历史动态
            </p>
          </div>
        </div>
        <button
          @click="!running && emit('close')"
          :disabled="running"
          class="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- Scrollable Modal Body -->
      <div class="space-y-4 overflow-y-auto flex-1 pr-1">
        <!-- 1. Channels Selection -->
        <div class="space-y-2">
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            选择要回溯的账号
          </label>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div
              v-for="ch in channels.filter(c => c.creatorId === creator?.id)"
              :key="ch.id"
              @click="toggleChannel(ch.id)"
              :class="selectedChannels.includes(ch.id) ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300' : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-slate-600 dark:text-slate-400'"
              class="flex items-center gap-2 p-2.5 rounded-xl border transition-all cursor-pointer select-none text-xs"
            >
              <div class="w-4 h-4 flex items-center justify-center shrink-0">
                <CheckSquare v-if="selectedChannels.includes(ch.id)" class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <Square v-else class="w-4 h-4 text-slate-400" />
              </div>
              <span :class="PLATFORM_REGISTRY[ch.platform]?.badgeBg" class="px-1.5 py-0.5 rounded text-[10px] font-bold border shrink-0">
                {{ PLATFORM_REGISTRY[ch.platform]?.name || ch.platform }}
              </span>
              <span class="truncate font-medium">{{ ch.displayName || ch.accountId }}</span>
            </div>
          </div>
          <p v-if="selectedChannels.length === 0" class="text-[11px] text-rose-500">
            请至少选择一个账号
          </p>
        </div>

        <!-- 2. Target Mode: By Count vs By Time Range -->
        <div class="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            回溯范围
          </label>
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              :disabled="running"
              @click="mode = 'count'"
              :class="mode === 'count' ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-transparent hover:bg-slate-200 dark:hover:bg-slate-700'"
              class="py-2 px-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer text-center"
            >
              按数量
            </button>
            <button
              type="button"
              :disabled="running"
              @click="mode = 'time'"
              :class="mode === 'time' ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-transparent hover:bg-slate-200 dark:hover:bg-slate-700'"
              class="py-2 px-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer text-center"
            >
              按时间
            </button>
          </div>
        </div>

        <!-- Sub-mode A: Count Selection -->
        <div v-if="mode === 'count'" class="space-y-2 bg-slate-50 dark:bg-slate-850 p-3 rounded-xl border border-slate-200/70 dark:border-slate-800">
          <div class="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 mb-1">
            <span class="font-medium">目标数量：</span>
            <span class="font-bold text-indigo-600 dark:text-indigo-400">
              {{ targetCount === 0 ? '全部' : `${targetCount} 条` }}
            </span>
          </div>

          <!-- Quick Pill Options -->
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="preset in [30, 50, 100, 200, 0]"
              :key="preset"
              type="button"
              :disabled="running"
              @click="setCountPreset(preset)"
              :class="targetCount === preset ? 'bg-indigo-600 text-white font-bold' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50'"
              class="px-2.5 py-1 rounded-lg text-xs transition-colors cursor-pointer"
            >
              {{ preset === 0 ? '全部' : `${preset} 条` }}
            </button>
          </div>

          <!-- Custom Number Input -->
          <div class="flex items-center gap-2 pt-2 text-xs">
            <span class="text-slate-500 text-[11px] shrink-0">自定义条数:</span>
            <input
              v-model.number="customCount"
              @input="targetCount = customCount"
              type="number"
              min="5"
              max="1000"
              step="10"
              :disabled="running"
              class="w-24 px-2.5 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500 font-semibold text-slate-800 dark:text-slate-100"
            />
            <span class="text-slate-400 text-[11px]">(建议 30-200)</span>
          </div>
        </div>

        <!-- Sub-mode B: Time Range Selection -->
        <div v-else class="space-y-2 bg-slate-50 dark:bg-slate-850 p-3 rounded-xl border border-slate-200/70 dark:border-slate-800">
          <div class="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 mb-1">
            <span class="font-medium">时间范围：</span>
            <span class="font-bold text-indigo-600 dark:text-indigo-400">
              {{ timeRange === 0 ? '全部历史作品' : `近 ${timeRange} 天内的作品` }}
            </span>
          </div>

          <div class="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
            <button
              v-for="range in [{ days: 30, label: '近 1 个月' }, { days: 90, label: '近 3 个月' }, { days: 180, label: '近半年' }, { days: 365, label: '近 1 年' }, { days: 0, label: '不限时间' }]"
              :key="range.days"
              type="button"
              :disabled="running"
              @click="timeRange = range.days"
              :class="timeRange === range.days ? 'bg-indigo-600 text-white font-bold' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50'"
              class="py-1.5 px-2 rounded-lg text-xs transition-colors cursor-pointer text-center"
            >
              {{ range.label }}
            </button>
          </div>
        </div>

        <!-- Filter Options (Only Original) -->
        <div class="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-850 rounded-xl border border-slate-200/70 dark:border-slate-800 text-xs">
          <div class="space-y-0.5">
            <div class="font-medium text-slate-800 dark:text-slate-200">仅原创</div>
            <div class="text-[11px] text-slate-400">跳过转发内容，专注回溯创作者本人产出的内容</div>
          </div>
          <input
            v-model="onlyOriginal"
            :disabled="running"
            type="checkbox"
            class="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
          />
        </div>

        <!-- Reset Cursor Option -->
        <div class="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-850 rounded-xl border border-slate-200/70 dark:border-slate-800 text-xs">
          <div class="space-y-0.5">
            <div class="font-medium text-slate-800 dark:text-slate-200">重置历史进度（重新深度扫描）</div>
            <div class="text-[11px] text-slate-400">若此前已显示到头或需重新扫描修复旧数据，勾选此项重置断点并重新回溯</div>
          </div>
          <input
            v-model="resetCursor"
            :disabled="running"
            type="checkbox"
            class="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
          />
        </div>

        <!-- Real-time Deep Sync Logs & Status Window -->
        <div v-if="logs.length > 0 || running" class="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div class="flex items-center justify-between text-xs">
            <span class="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <span v-if="running" class="w-2 h-2 rounded-full bg-indigo-500 animate-ping"></span>
              <span>{{ currentStatus || '回溯中...' }}</span>
            </span>
            <span class="font-bold text-indigo-600 dark:text-indigo-400">
              已获取 {{ totalNew }} 条
            </span>
          </div>
          <div class="p-2.5 bg-slate-900 text-emerald-400 font-mono text-[11px] rounded-xl h-28 overflow-y-auto space-y-1">
            <div v-for="(log, idx) in logs" :key="idx" class="leading-relaxed">
              {{ log }}
            </div>
          </div>
        </div>
      </div>

      <!-- Footer Action Buttons -->
      <div class="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800 shrink-0">
        <button
          v-if="running"
          @click="emit('stop')"
          class="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-semibold cursor-pointer shadow-xs"
        >
          <StopCircle class="w-4 h-4" />
          <span>停止</span>
        </button>
        <div v-else class="text-[11px] text-slate-400">
          已抓取历史动态自动去重存入本地
        </div>

        <div class="flex items-center gap-2">
          <button
            @click="emit('close')"
            :disabled="running"
            class="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer disabled:opacity-50"
          >
            关闭
          </button>
          <button
            v-if="!running"
            @click="start"
            :disabled="selectedChannels.length === 0"
            class="flex items-center gap-1.5 px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-xl shadow-xs cursor-pointer"
          >
            <Play class="w-3.5 h-3.5" />
            <span>开始回溯</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
