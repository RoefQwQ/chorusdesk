<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Folder, FolderCheck, HardDrive, DownloadCloud, RefreshCw, XCircle } from 'lucide-vue-next';
import { imageCacheService } from '../../../src/services/imageCache';
import { devLog } from '../../../src/utils/devLog';
import type { AppSettings, Post, Creator } from '../../../src/types';
import { errorMessage } from '../../../src/utils/errorMessage';

const props = defineProps<{
  settings: AppSettings;
  posts: Post[];
  creators: Creator[];
}>();

const emit = defineEmits<{
  updateSettings: [settings: Partial<AppSettings>];
}>();

const isReady = ref(false);
const boundDirName = ref<string>('');
const isBinding = ref(false);
const isBatchCaching = ref(false);
const batchProgress = ref({ current: 0, total: 0, success: 0, skipped: 0, failed: 0 });
/** 归档并发数：File System Access 写盘很快，瓶颈在网络；3 路并发是
 * 保守值，避免触发平台防盗链/风控（与同步层 minPlatformIntervalMs 同思路）。 */
const BATCH_CONCURRENCY = 3;

async function checkStatus() {
  const status = await imageCacheService.isReady();
  isReady.value = status.ready;
  boundDirName.value = status.dirName || props.settings.imageCacheDirectoryName || '';
}

onMounted(() => {
  checkStatus();
});

async function handleSelectDirectory() {
  if (isBinding.value) return;
  isBinding.value = true;
  try {
    const res = await imageCacheService.bindDirectory();
    if (res.success && res.dirName) {
      boundDirName.value = res.dirName;
      isReady.value = true;
      emit('updateSettings', {
        enableImageCache: true,
        imageCacheDirectoryName: res.dirName,
      });
      alert(`【本地目录绑定成功】已选定文件夹 "${res.dirName}"。此后图片将分类归档至该目录下！`);
    } else if (res.error && res.error !== '已取消选择目录') {
      alert('绑定失败: ' + res.error);
    }
  } catch (err: unknown) {
    alert('操作异常: ' + (errorMessage(err)));
  } finally {
    isBinding.value = false;
    checkStatus();
  }
}

async function handleUnbindDirectory() {
  if (!confirm('确定要解绑当前的本地图片缓存目录吗？\n（已保存在您电脑上的物理图片文件不会被删除）')) {
    return;
  }
  await imageCacheService.unbindDirectory();
  isReady.value = false;
  boundDirName.value = '';
  emit('updateSettings', {
    enableImageCache: false,
    imageCacheDirectoryName: '',
  });
}

async function handleBatchCacheExisting() {
  if (!isReady.value) {
    alert('请先点击上方“选择/更改本地目录”绑定一个磁盘文件夹！');
    return;
  }

  if (isBatchCaching.value) return;

  const targetPosts = props.posts.filter(p => p.mediaList && p.mediaList.length > 0);
  if (targetPosts.length === 0) {
    alert('当前动态列表中没有包含图片的动态');
    return;
  }

  isBatchCaching.value = true;
  batchProgress.value = { current: 0, total: targetPosts.length, success: 0, skipped: 0, failed: 0 };

  const creatorMap = new Map<string, string>();
  props.creators.forEach(c => creatorMap.set(c.id, c.name));

  // Incremental: probe disk first; fully-cached posts cost zero network.
  // The probe resolves the post directory, whose first segment is the creator
  // name — pass the exact name the downloads below use, or every probe misses.
  const pending: typeof targetPosts = [];
  for (const post of targetPosts) {
    const cached = await imageCacheService
      .isPostFullyCached(post, creatorMap.get(post.creatorId) || '默认创作者')
      .catch(() => false);
    if (cached) {
      batchProgress.value.skipped++;
      batchProgress.value.current++;
    } else {
      pending.push(post);
    }
  }

  let cursor = 0;
  const failures: string[] = [];
  const runOne = async (post: (typeof targetPosts)[number]) => {
    const creatorName = creatorMap.get(post.creatorId) || '默认创作者';
    const count = await imageCacheService.cachePost(post, creatorName).catch(() => 0);
    if (count > 0) {
      batchProgress.value.success += count;
    } else {
      batchProgress.value.failed++;
      failures.push(post.id);
    }
    batchProgress.value.current++;
  };

  try {
    // Small worker pool: keeps the loop resilient (one failure never aborts
    // the archive) while bounding concurrent network requests.
    const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, pending.length) }, async () => {
      while (cursor < pending.length) {
        await runOne(pending[cursor++]);
      }
    });
    await Promise.all(workers);

    const summary = [
      `共扫描 ${targetPosts.length} 条图文动态`,
      `新归档 ${batchProgress.value.success} 张`,
      `已缓存跳过 ${batchProgress.value.skipped} 条`,
    ];
    if (batchProgress.value.failed > 0) {
      summary.push(`${batchProgress.value.failed} 条下载失败（可稍后重试）`);
    }
    devLog.info('imageCache', '离线归档完成', summary.join('，'));
    if (failures.length > 0) {
      // Ids only: enough to identify which posts to retry.
      devLog.warn('imageCache', `${failures.length} 条作品归档失败`, failures.slice(0, 20).join(', '));
    }
    alert(`【离线归档完成】${summary.join('，')}。归档目录: "${boundDirName.value}"`);
  } catch (err: unknown) {
    alert('批量缓存异常: ' + (errorMessage(err)));
  } finally {
    isBatchCaching.value = false;
  }
}

</script>

<template>
  <div class="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
    <div class="flex items-center justify-between">
      <div>
        <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
          <HardDrive class="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <span>本地磁盘图片缓存 (分博主/渠道归档)</span>
          <span
            class="px-2 py-0.5 rounded-full text-[10px] font-semibold border"
            :class="isReady ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800' : 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400'"
          >
            {{ isReady ? '已授权连接' : '未配置目录' }}
          </span>
        </h3>
        <p class="text-[11px] text-slate-400 mt-0.5">
          直接在电脑硬盘中按 <code class="bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-indigo-600 dark:text-indigo-400 font-mono">博主/平台/日期_动态ID</code> 自动归档原图，离线永久可查，小红书等时效签名过期永不失效
        </p>
      </div>
    </div>

    <!-- Directory Binding Card -->
    <div class="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 space-y-3">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div
            class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border shadow-2xs"
            :class="isReady ? 'bg-indigo-50 dark:bg-indigo-950/50 border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400' : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400'"
          >
            <FolderCheck v-if="isReady" class="w-5 h-5" />
            <Folder v-else class="w-5 h-5" />
          </div>
          <div class="min-w-0">
            <div class="text-xs font-bold text-slate-900 dark:text-white truncate">
              {{ boundDirName ? `当前绑定的物理目录: ${boundDirName}` : '尚未选择图片本地保存目录' }}
            </div>
            <div class="text-[11px] text-slate-400 mt-0.5">
              {{ isReady ? '扩展已获得该文件夹的写入权限，浏览时将自动沉淀图片。' : '基于浏览器官方 File System Access API，由您自主决定图片存在哪个磁盘分区。' }}
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            @click="handleSelectDirectory"
            :disabled="isBinding"
            class="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-xs hover:shadow transition-all cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
          >
            <Folder class="w-3.5 h-3.5" />
            <span>{{ boundDirName ? '更改存储目录' : '选择本地存储目录' }}</span>
          </button>
          <button
            v-if="boundDirName"
            type="button"
            @click="handleUnbindDirectory"
            title="解绑目录"
            class="p-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
          >
            <XCircle class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Batch Cache Tool -->
      <div v-if="isReady" class="pt-3 border-t border-slate-200/60 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="text-slate-500 dark:text-slate-400 text-[11px] flex items-center gap-1.5">
          <DownloadCloud class="w-3.5 h-3.5 text-indigo-500" />
          <span>支持将数据库中现有的所有博主图文一键离线备份至该目录</span>
        </div>
        <button
          type="button"
          @click="handleBatchCacheExisting"
          :disabled="isBatchCaching"
          class="px-3 py-1.5 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-xl font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isBatchCaching }" />
          <span v-if="isBatchCaching" class="text-[10px] text-slate-400 font-mono">
            （新 {{ batchProgress.success }} · 跳过 {{ batchProgress.skipped }}<template v-if="batchProgress.failed"> · 失败 {{ batchProgress.failed }}</template>）
          </span>
          <span>{{ isBatchCaching ? `正在归档 ${batchProgress.current}/${batchProgress.total}...` : '一键离线当前全部图片（增量）' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
