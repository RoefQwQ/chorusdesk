<script setup lang="ts">
import {
  Bug,
  Download,
  ExternalLink,
  FolderDown,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-vue-next';
import { PLATFORM_REGISTRY, type AppSettings, type Creator, type RecycleSnapshot, type Post } from '../../../src/types';
import { toSecureMediaUrl } from '../../../src/utils/media';
import ImageCacheSettings from '../components/ImageCacheSettings.vue';
import AppSelect from '../components/AppSelect.vue';

export interface DashboardStatsView {
  creatorsCount: number;
  channelsCount: number;
  totalPostsCount: number;
  bookmarkedPostsCount: number;
  storageUsageBytes: number;
}

export interface SettingsViewContext {
  settings: AppSettings;
  posts: Post[];
  creators: Creator[];
  dbStats: DashboardStatsView;
  platformLoginStatus: Record<string, boolean>;
  isCheckingLogins: boolean;
  deletedPostCount: number;
  deletedPostsList: RecycleSnapshot[];
  filteredDeletedPostsList: RecycleSnapshot[];
  deletedPostsSearchQuery: string;
  isHealingMedia: boolean;
  isCleaningStorage: boolean;
  onAddSource: () => void;
  onCheckPlatformLogins: () => void | Promise<void>;
  onExportBackupToFile: () => void | Promise<void>;
  onExportBackup: () => void | Promise<void>;
  onImportFile: (file: File) => void | Promise<void>;
  onLoadDemoData: () => void | Promise<void>;
  onUpdateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
  onNotifyAutoSyncChanged: () => void;
  onRefresh: () => void | Promise<void>;
  onHealBrokenMedia: () => void | Promise<void>;
  onCleanupPosts: (days: number) => void | Promise<void>;
  onRestoreAll: () => void | Promise<void>;
  onEmptyRecycleBin: () => void | Promise<void>;
  onRestoreOne: (record: RecycleSnapshot) => void | Promise<void>;
  onPermanentDelete: (record: RecycleSnapshot) => void | Promise<void>;
  onSearchDeleted: (q: string) => void;
}

const props = withDefaults(
  defineProps<{ active?: boolean; context: SettingsViewContext }>(),
  { active: true }
);

const emit = defineEmits<{
  'open-dev-log': [];
}>();

/** 数值设置的选项表（原为模板内联 `<option>`，迁移到 AppSelect 后需保持同值同文案）。 */
const ITEMS_PER_FETCH_OPTIONS = [
  { value: 5, label: '5 条' },
  { value: 10, label: '10 条（推荐）' },
  { value: 20, label: '20 条' },
];

const REQUEST_DELAY_OPTIONS = [
  { value: 300, label: '300ms（快）' },
  { value: 600, label: '600ms（推荐）' },
  { value: 1200, label: '1200ms（保守）' },
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function handleImportChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    void props.context.onImportFile(file);
  }
  input.value = '';
}

function handleDeletedSearchInput(event: Event) {
  props.context.onSearchDeleted((event.target as HTMLInputElement).value);
}
function updateNumberSetting(key: 'itemsPerFetch' | 'requestDelayMs', value: string | number) {
  void props.context.onUpdateSettings({ [key]: Number(value) });
}

/**
 * Persist the switch, then let the worker reconcile the alarm.
 *
 * The order is load-bearing. `setupAutoSync` reads the **stored** setting, so
 * notifying before the write had committed had the worker read the old value
 * and take the `enableAutoSync === false` branch — which CLEARS the alarm the
 * user just switched on, leaving none until the next worker start. Measured in
 * the real extension host by `e2e/release-gate.mjs` (`alarm.enable-auto-sync`),
 * 2026-09-11.
 */
async function updateBooleanSetting(key: 'enableAutoSync' | 'hideReposts', event: Event) {
  const value = (event.target as HTMLInputElement).checked;
  try {
    await props.context.onUpdateSettings({ [key]: value });
  } catch (err) {
    // A setting that did not land must not drive a reconcile: the worker would
    // act on the previous value.
    console.warn('[Chorus] 设置保存失败：', err);
    return;
  }
  if (key === 'enableAutoSync') props.context.onNotifyAutoSyncChanged();
}
</script>

<template>
  <section v-if="active" class="max-w-3xl mx-auto space-y-6">
    <!-- Security & Architecture Guarantee Banner -->
    <div class="p-5 bg-gradient-to-r from-indigo-900/10 to-violet-900/10 dark:from-indigo-950/50 dark:to-violet-950/50 border border-indigo-200 dark:border-indigo-800/60 rounded-2xl flex items-start gap-3">
      <ShieldCheck class="w-6 h-6 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
      <div class="text-xs space-y-1">
        <h4 class="font-bold text-slate-900 dark:text-white text-sm">隐私与安全</h4>
        <p class="text-slate-600 dark:text-slate-300 leading-relaxed">
          所有数据仅存储在本地浏览器中，不会上传任何信息到外部服务器。
        </p>
      </div>
    </div>

    <!-- Platform Service Hub & Adapter Matrix -->
    <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-5">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
            <span>平台与登录状态</span>
          </h3>
          <p class="text-xs text-slate-500 mt-0.5">
            查看各平台的登录状态和连接情况
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            @click="context.onAddSource"
            class="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 rounded-lg border border-indigo-200 dark:border-indigo-800 flex items-center gap-1 cursor-pointer transition-colors"
          >
            <Plus class="w-3.5 h-3.5" />
            <span>+ 添加 RSS 源</span>
          </button>
          <button
            @click="context.onCheckPlatformLogins"
            :disabled="context.isCheckingLogins"
            class="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 rounded-lg hover:bg-slate-200 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': context.isCheckingLogins }" />
            <span>{{ context.isCheckingLogins ? '检测中…' : '检测登录状态' }}</span>
          </button>
        </div>
      </div>

      <!-- Architecture & auth guide -->
      <div class="p-3.5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200/60 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300 space-y-1.5">
        <div class="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
          <Sparkles class="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span>登录说明：</span>
        </div>
        <p>• <b>大多数平台</b>（B站、Pixiv、Fantia 等）自动使用浏览器登录状态，在主站登录即可生效。</p>
        <p>• <b>抗限流同源抓取</b>：X (Twitter) 结合浏览器活跃标签页与同源请求，保障同步稳定性。</p>
        <p>• <b>通用订阅协议</b>：支持标准 RSS 2.0 / Atom 1.0 与 RSSHub 源，订阅博客、Substack 等外部内容。</p>
      </div>

      <!-- Platform Grid with Per-Platform Contextual Actions -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        <div
          v-for="(meta, key) in PLATFORM_REGISTRY"
          :key="key"
          class="p-4 bg-slate-50/80 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-800 rounded-xl flex flex-col justify-between gap-3 shadow-2xs"
        >
          <div>
            <div class="flex items-start justify-between gap-2 mb-1.5">
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-bold text-xs text-slate-900 dark:text-white truncate">{{ meta.name }}</span>
                <span
                  class="px-1.5 py-0.2 rounded text-[9px] font-medium bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300 truncate shrink-0"
                  :title="`鉴权方式：${meta.authTypeName}`"
                >
                  {{ meta.authTypeName }}
                </span>
              </div>
              <span
                class="w-2.5 h-2.5 rounded-full shrink-0 mt-0.5"
                :class="context.platformLoginStatus[key] ? 'bg-emerald-500 shadow-xs shadow-emerald-500/50' : 'bg-amber-400'"
                :title="context.platformLoginStatus[key] ? '就绪（可同步）' : '未检测到会话'"
              ></span>
            </div>
            <!-- The description is clamped to two lines for even card heights, so
                 the full text has to be reachable on hover — otherwise the
                 trailing sentence (what the platform actually supports) is
                 unreadable with no way to recover it. -->
            <p
              class="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed"
              :title="meta.description"
            >
              {{ meta.description }}
            </p>
          </div>

          <!-- Contextual Action per Platform -->
          <div class="pt-2 border-t border-slate-200/50 dark:border-slate-800/80">
            <button
              v-if="key === 'twitter'"
              @click="context.onCheckPlatformLogins"
              :disabled="context.isCheckingLogins"
              class="w-full py-1.5 px-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': context.isCheckingLogins }" />
              <span>{{ context.isCheckingLogins ? '检测中…' : '检测 X/Twitter 登录' }}</span>
            </button>

            <!-- RSS specific action -->
            <button
              v-else-if="key === 'rss'"
              @click="context.onAddSource"
              class="w-full py-1.5 px-2 text-xs font-medium text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 rounded-lg border border-indigo-200 dark:border-indigo-800 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <Plus class="w-3.5 h-3.5" />
              <span>添加 RSS 订阅</span>
            </button>

            <!-- Cookie based or open platforms -->
            <a
              v-else
              :href="`https://${meta.domain}`"
              target="_blank"
              class="w-full py-1.5 px-2 text-xs font-medium text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg flex items-center justify-center gap-1.5 transition-colors"
            >
              <span>打开登录页 ↗</span>
            </a>
          </div>
        </div>

        <!-- Custom Feed Expansion Slot -->
        <div
          @click="context.onAddSource"
          class="p-4 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-600 flex flex-col items-center justify-center text-center cursor-pointer transition-all group bg-slate-50/40 dark:bg-slate-800/40"
        >
          <div class="w-8 h-8 rounded-full bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-indigo-600 mb-1.5 group-hover:scale-110 transition-transform">
            <Plus class="w-4 h-4" />
          </div>
          <span class="font-bold text-xs text-slate-800 dark:text-slate-200">添加自定义 RSS / 独立源</span>
          <span class="text-[10px] text-slate-400 mt-0.5">支持博客、Substack 或 RSSHub</span>
        </div>
      </div>
    </div>

    <!-- Data Backup & Restore -->
    <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
      <div>
        <h3 class="font-bold text-base text-slate-900 dark:text-white">数据备份与导出</h3>
        <p class="text-xs text-slate-500 mt-0.5">创作者档案与动态均安全保存在浏览器本地，支持随时导出与恢复独立备份。</p>
      </div>

      <div class="flex flex-wrap gap-3">
        <button
          @click="context.onExportBackupToFile"
          class="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-xs transition-colors cursor-pointer"
        >
          <FolderDown class="w-4 h-4" />
          <span>导出到文件</span>
        </button>

        <button
          @click="context.onExportBackup"
          class="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
        >
          <Download class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <span>下载 JSON 备份</span>
        </button>

        <label class="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl text-xs font-semibold transition-colors cursor-pointer">
          <Upload class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <span>导入备份</span>
          <input type="file" accept=".json" class="hidden" @change="handleImportChange" />
        </label>

        <button
          @click="context.onLoadDemoData"
          class="flex items-center gap-2 px-4 py-2.5 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 text-indigo-600 dark:text-indigo-300 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
        >
          <Sparkles class="w-4 h-4" />
          <span>导入演示数据</span>
        </button>
      </div>
    </div>

    <!-- Fetch Preferences -->
    <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
      <h3 class="font-bold text-base text-slate-900 dark:text-white">同步设置</h3>
      <div class="space-y-3">
        <div class="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 text-xs">
          <div>
            <div class="font-semibold text-slate-800 dark:text-slate-200">每次获取条数</div>
            <div class="text-[11px] text-slate-400">每次同步时获取的动态条数</div>
          </div>
          <AppSelect
            :model-value="context.settings.itemsPerFetch"
            :options="ITEMS_PER_FETCH_OPTIONS"
            aria-label="每次获取条数"
            @update:model-value="(v) => updateNumberSetting('itemsPerFetch', v)"
          />
        </div>

        <div class="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 text-xs">
          <div>
            <div class="font-semibold text-slate-800 dark:text-slate-200">请求间隔</div>
            <div class="text-[11px] text-slate-400">连续同步多个账号时的请求间隔，避免触发平台限制</div>
          </div>
          <AppSelect
            :model-value="context.settings.requestDelayMs"
            :options="REQUEST_DELAY_OPTIONS"
            aria-label="请求间隔"
            @update:model-value="(v) => updateNumberSetting('requestDelayMs', v)"
          />
        </div>

        <div class="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 text-xs">
          <div>
            <div class="font-semibold text-slate-800 dark:text-slate-200">后台自动更新</div>
            <div class="text-[11px] text-slate-400">关闭后仅在手动点击“同步全部”时拉取，冷启动与后台绝不发起任何抓取请求</div>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              :checked="context.settings.enableAutoSync"
              @change="updateBooleanSetting('enableAutoSync', $event)"
              class="sr-only peer"
            />
            <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
          </label>
        </div>

        <div class="flex items-center justify-between py-2 text-xs">
          <div>
            <div class="font-semibold text-slate-800 dark:text-slate-200">默认隐藏转发</div>
            <div class="text-[11px] text-slate-400">默认隐藏转发/转推内容，可在动态页随时切换</div>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              :checked="context.settings.hideReposts"
              @change="updateBooleanSetting('hideReposts', $event)"
              class="sr-only peer"
            />
            <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
          </label>
        </div>
      </div>
    </div>

    <!-- Local Disk Image Cache (File System Access API) -->
    <ImageCacheSettings
      :settings="context.settings"
      :posts="context.posts"
      :creators="context.creators"
      @updateSettings="context.onUpdateSettings"
    />

    <!-- Database Health & Cache Cleanup -->
    <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
            <span>存储管理</span>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800">
              运行良好
            </span>
          </h3>
          <p class="text-[11px] text-slate-400 mt-0.5">数据存储在本地浏览器中，可手动清理历史数据释放空间</p>
        </div>
        <button
          type="button"
          @click="context.onRefresh"
          class="px-2.5 py-1 text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
        >
          刷新
        </button>
      </div>

      <!-- Metrics Grid -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/60">
          <div class="text-[10px] text-slate-400 font-medium">动态总数</div>
          <div class="text-base font-bold text-slate-900 dark:text-white mt-0.5">{{ context.dbStats.totalPostsCount }} 条</div>
        </div>
        <div class="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/60">
          <div class="text-[10px] text-slate-400 font-medium">收藏数</div>
          <div class="text-base font-bold text-amber-600 dark:text-amber-400 mt-0.5">{{ context.dbStats.bookmarkedPostsCount }} 条</div>
        </div>
        <div class="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/60">
          <div class="text-[10px] text-slate-400 font-medium">存储占用</div>
          <div class="text-base font-bold text-indigo-600 dark:text-indigo-400 mt-0.5">{{ formatBytes(context.dbStats.storageUsageBytes) }}</div>
        </div>
        <div class="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/60">
          <div class="text-[10px] text-slate-400 font-medium">创作者 / 账号</div>
          <div class="text-base font-bold text-slate-900 dark:text-white mt-0.5">{{ context.dbStats.creatorsCount }} 位 / {{ context.dbStats.channelsCount }} 个</div>
        </div>
      </div>

      <!-- Actions -->
      <div class="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div class="text-slate-400 text-[11px] leading-relaxed max-w-md">
          收藏的动态不会被清理，永久保留。
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="context.onHealBrokenMedia"
            :disabled="context.isHealingMedia"
            class="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/60 rounded-xl font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
            title="自动扫描并纠正本地数据库中小红书受限 CDN 域名，恢复旧笔记正常显示"
          >
            <Sparkles class="w-3.5 h-3.5" :class="{ 'animate-spin': context.isHealingMedia }" />
            <span>{{ context.isHealingMedia ? '修复中…' : '一键修复小红书图裂' }}</span>
          </button>
          <button
            type="button"
            @click="context.onCleanupPosts(60)"
            :disabled="context.isCleaningStorage"
            class="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-medium transition-colors cursor-pointer disabled:opacity-50"
          >
            清理 60 天前数据
          </button>
          <button
            type="button"
            @click="context.onCleanupPosts(30)"
            :disabled="context.isCleaningStorage"
            class="px-3 py-1.5 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60 rounded-xl font-medium transition-colors cursor-pointer disabled:opacity-50"
          >
            清理 30 天前数据
          </button>
        </div>
      </div>
    </div>

    <!-- Diagnostics & Troubleshooting -->
    <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
      <div>
        <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
          <Bug class="w-4 h-4 text-slate-400" />
          <span>诊断与排查</span>
        </h3>
        <p class="text-[11px] text-slate-400 mt-0.5">
          同步失败、图片不显示或授权异常时，先在这里看后台到底发生了什么
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <button
          @click="emit('open-dev-log')"
          class="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
          title="查看后台消息、各平台请求状态、同步错误码与 RSS 授权结果"
        >
          <Bug class="w-4 h-4 text-slate-500" />
          <span>开发者日志</span>
        </button>
        <span class="text-[11px] text-slate-400 leading-relaxed max-w-md">
          记录后台消息、平台返回码、同步结果与授权过程，可筛选并一键复制；
          仅存于本次浏览器会话，不进入数据库与备份。
        </span>
      </div>
    </div>

    <!-- Dynamic Recycle Bin Card (In Settings) -->
    <div id="recycle-bin-section" class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
            <Trash2 class="w-4 h-4 text-rose-500" />
            <span>动态回收站</span>
            <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800/60">
              {{ context.deletedPostCount }} 条记录
            </span>
          </h3>
          <p class="text-xs text-slate-500 mt-1">
            手动删除的动态将存入回收站，同步时默认不再抓取。可随时在此恢复到动态列表，避免误删丢失。
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            v-if="context.deletedPostCount > 0"
            @click="context.onRestoreAll"
            class="px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
            title="将回收站中的所有动态定向还原到动态列表"
          >
            <RotateCcw class="w-3.5 h-3.5" />
            <span>全部找回并还原</span>
          </button>
          <button
            type="button"
            v-if="context.deletedPostCount > 0"
            @click="context.onEmptyRecycleBin"
            class="px-3.5 py-1.5 text-xs font-semibold text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer flex items-center gap-1"
            title="彻底清空回收站"
          >
            <span>清空回收站</span>
          </button>
        </div>
      </div>

      <!-- Filter & Search (if records exist) -->
      <div v-if="context.deletedPostsList.length > 0" class="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div class="relative flex-1">
          <Search class="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            :value="context.deletedPostsSearchQuery"
            @input="handleDeletedSearchInput"
            type="text"
            placeholder="搜索已删除动态关键词、标题或 ID…"
            class="w-full pl-8.5 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-900 dark:text-white placeholder-slate-400"
          />
        </div>
      </div>

      <!-- Recycle Bin Items List -->
      <div class="space-y-2.5 max-h-96 overflow-y-auto pr-1">
        <div
          v-if="context.filteredDeletedPostsList.length === 0"
          class="py-8 text-center bg-slate-50/50 dark:bg-slate-800/30 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 text-xs text-slate-400"
        >
          <Trash2 class="w-6 h-6 mx-auto mb-2 text-slate-300 dark:text-slate-600" />
          <span>{{ context.deletedPostsSearchQuery ? '未找到符合搜索条件的回收站记录' : '回收站为空，暂无已删除动态' }}</span>
        </div>

        <div
          v-for="record in context.filteredDeletedPostsList"
          :key="record.id"
          class="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 rounded-xl border border-slate-200/80 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition-all hover:border-slate-300 dark:hover:border-slate-700"
        >
          <div class="flex items-start gap-3 min-w-0 flex-1">
            <!-- Media cover / thumbnail if available -->
            <div
              v-if="record.postData?.mediaList?.length"
              class="w-13 h-13 rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800 shrink-0 border border-slate-200 dark:border-slate-700"
            >
              <img
                :src="toSecureMediaUrl(record.postData.mediaList[0].previewUrl)"
                referrerpolicy="no-referrer"
                class="w-full h-full object-cover"
              />
            </div>

            <div class="min-w-0 space-y-1 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span
                  v-if="record.platform || record.postData?.platform"
                  :class="PLATFORM_REGISTRY[record.platform || record.postData?.platform || '']?.badgeBg"
                  class="px-1.5 py-0.2 rounded text-[9px] font-bold border shrink-0"
                >
                  {{ PLATFORM_REGISTRY[record.platform || record.postData?.platform || '']?.name || record.platform }}
                </span>
                <h4 class="font-bold text-slate-900 dark:text-white truncate max-w-md">
                  {{ record.title || record.postData?.title || '未命名动态' }}
                </h4>
              </div>

              <p v-if="record.postData?.content" class="text-xs text-slate-500 dark:text-slate-400 line-clamp-1">
                {{ record.postData.content }}
              </p>

              <div class="flex items-center gap-2 text-[10px] text-slate-400 flex-wrap">
                <span class="font-mono truncate max-w-[140px]">ID: {{ record.id }}</span>
                <span>•</span>
                <span>删除于 {{ new Date(record.deletedAt).toLocaleString('zh-CN') }}</span>
                <span v-if="record.postData?.publishedAt">• 发布于 {{ new Date(record.postData.publishedAt).toLocaleDateString('zh-CN') }}</span>
              </div>
            </div>
          </div>

          <!-- Action buttons on each item -->
          <div class="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
            <button
              type="button"
              @click="context.onRestoreOne(record)"
              class="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 rounded-xl transition-colors cursor-pointer flex items-center gap-1"
              title="立即将此动态定向找回并还原到动态流"
            >
              <RotateCcw class="w-3.5 h-3.5" />
              <span>定向找回</span>
            </button>
            <a
              v-if="record.postData?.originalUrl"
              :href="record.postData.originalUrl"
              target="_blank"
              class="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
              title="打开原帖"
            >
              <ExternalLink class="w-3.5 h-3.5" />
            </a>
            <button
              type="button"
              @click="context.onPermanentDelete(record)"
              class="p-1.5 text-slate-400 hover:text-rose-500 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
              title="彻底删除"
            >
              <Trash2 class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
