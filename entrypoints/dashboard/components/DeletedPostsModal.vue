<script setup lang="ts">
import { Trash2, X, Search, RotateCcw } from 'lucide-vue-next';
import { PLATFORM_REGISTRY, type DeletedPostRecord } from '../../../src/types';
import { toSecureMediaUrl } from '../../../src/utils/media';
import BaseModal from './BaseModal.vue';

defineProps<{
  records: DeletedPostRecord[];
  filteredRecords: DeletedPostRecord[];
  searchQuery: string;
}>();
const emit = defineEmits<{
  close: [];
  'update:searchQuery': [value: string];
  'restore-one': [record: DeletedPostRecord];
  'permanent-delete': [record: DeletedPostRecord];
  'restore-all-and-sync': [];
}>();
const secure = toSecureMediaUrl;
</script>
<template>
  <BaseModal
    overlay-class="bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
    @close="emit('close')"
  >
    <div class="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-3xl p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4 max-h-[85vh] flex flex-col">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div>
          <h3 class="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
            <Trash2 class="w-4 h-4 text-rose-500" />
            <span>已删除动态管理</span>
            <span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-normal">
              共 {{ records.length }} 条记录
            </span>
          </h3>
          <p class="text-xs text-slate-500 mt-1">
            已记录动态的内联 ID。顶部“一键同步”默认跳过这些动态。点击“恢复”可解除过滤，下次同步时重新拉取。
          </p>
        </div>
        <button
          type="button"
          class="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          @click="emit('close')"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Search box if multiple records -->
      <div v-if="records.length > 3" class="relative shrink-0">
        <Search class="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          :value="searchQuery"
          @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
          type="text"
          placeholder="搜索已删除动态标题或 ID…"
          class="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-900 dark:text-white placeholder-slate-400"
        />
      </div>

      <!-- Records List -->
      <div class="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[160px]">
        <div v-if="filteredRecords.length === 0" class="py-12 text-center text-xs text-slate-400">
          {{ searchQuery ? '没有找到匹配的记录' : '暂无已删除动态记录' }}
        </div>
        <div
          v-for="record in filteredRecords"
          :key="record.id"
          class="p-3 bg-slate-50/80 dark:bg-slate-800/60 rounded-xl border border-slate-200/70 dark:border-slate-800 flex items-center justify-between gap-3 text-xs"
        >
          <div class="flex items-center gap-3 min-w-0">
            <div
              v-if="record.postData?.mediaList?.length"
              class="w-11 h-11 rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800 shrink-0 border border-slate-200 dark:border-slate-700"
            >
              <img
                :src="secure(record.postData.mediaList[0].previewUrl)"
                referrerpolicy="no-referrer"
                class="w-full h-full object-cover"
              />
            </div>
            <div class="min-w-0 space-y-0.5">
              <div class="flex items-center gap-2 min-w-0">
                <span
                  v-if="record.platform || record.postData?.platform"
                  :class="PLATFORM_REGISTRY[record.platform || record.postData?.platform || '']?.badgeBg"
                  class="px-1.5 py-0.2 rounded text-[9px] font-bold border shrink-0"
                >
                  {{ PLATFORM_REGISTRY[record.platform || record.postData?.platform || '']?.name || record.platform }}
                </span>
                <span class="font-medium text-slate-800 dark:text-slate-200 truncate max-w-sm">
                  {{ record.title || record.postData?.title || '未命名动态' }}
                </span>
              </div>
              <div class="flex items-center gap-2 text-[10px] text-slate-400">
                <span class="font-mono">ID: {{ record.id }}</span>
                <span>•</span>
                <span>删除于 {{ new Date(record.deletedAt).toLocaleString('zh-CN') }}</span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              @click="emit('restore-one', record)"
              class="px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 rounded-lg transition-colors cursor-pointer flex items-center gap-1"
              title="立即将此动态定向找回并无缝还原至动态流"
            >
              <RotateCcw class="w-3 h-3" />
              <span>定向找回</span>
            </button>
            <button
              type="button"
              @click="emit('permanent-delete', record)"
              class="p-1 text-slate-400 hover:text-rose-500 rounded-md hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
              title="彻底删除"
            >
              <Trash2 class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <!-- Modal Footer -->
      <div class="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <button
            v-if="records.length > 0"
            type="button"
            @click="emit('restore-all-and-sync')"
            class="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <RotateCcw class="w-3.5 h-3.5" />
            <span>全部定向找回并还原</span>
          </button>
        </div>
        <button
          type="button"
          @click="emit('close')"
          class="px-4 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
        >
          完成
        </button>
      </div>
    </div>
  </BaseModal>
</template>
