<script setup lang="ts">
import { ref, watch } from 'vue';
import { X, Tag, Plus, Trash2 } from 'lucide-vue-next';
import type { Creator } from '../../../src/types';
import BaseModal from './BaseModal.vue';

const props = defineProps<{
  creator: Creator;
  /** 全库所有标签（推荐区），含当前选中状态。 */
  allTags: string[];
  /** 全局删除一个标签（父层负责落库/清过滤/刷新）。 */
  deleteGlobalTag: (tag: string) => void | Promise<void>;
}>();
const emit = defineEmits<{
  close: [];
  save: [tags: string[]];
}>();

const editingTagsList = ref<string[]>([]);
const newTagInput = ref('');

// Reset the editing draft whenever a new creator opens the modal.
watch(
  () => props.creator,
  (creator) => {
    editingTagsList.value = [...(creator?.tags || [])];
    newTagInput.value = '';
  },
  { immediate: true }
);

function addTagToEditingList(t?: string) {
  const raw = (t !== undefined ? t : newTagInput.value).trim().replace(/^#/, '');
  if (!raw) return;
  const splitTags = raw.split(/[,，\s]+/).filter(Boolean);
  for (const tag of splitTags) {
    const cleanTag = tag.trim().replace(/^#/, '');
    if (cleanTag && !editingTagsList.value.includes(cleanTag)) {
      editingTagsList.value.push(cleanTag);
    }
  }
  if (t === undefined) {
    newTagInput.value = '';
  }
}

function removeTagFromEditingList(tagToRemove: string) {
  editingTagsList.value = editingTagsList.value.filter(t => t !== tagToRemove);
}

function toggleTagInEditingList(tag: string) {
  if (editingTagsList.value.includes(tag)) {
    removeTagFromEditingList(tag);
  } else {
    editingTagsList.value.push(tag);
  }
}

function save() {
  // If user typed something in newTagInput without pressing enter or clicking add, include it
  if (newTagInput.value.trim()) {
    addTagToEditingList();
  }
  emit('save', [...editingTagsList.value]);
  editingTagsList.value = [];
  newTagInput.value = '';
}
</script>
<template>
  <BaseModal
    overlay-class="bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
    :close-on-backdrop="false"
    @close="emit('close')"
  >
    <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4 animate-scale-up">
      <!-- Modal Header -->
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-indigo-600">
            <Tag class="w-4 h-4" />
          </div>
          <div>
            <h3 class="font-bold text-sm text-slate-900 dark:text-white">编辑标签 - {{ creator.name }}</h3>
            <p class="text-[11px] text-slate-500">管理此创作者的分类标签</p>
          </div>
        </div>
        <button
          type="button"
          @click="emit('close')"
          class="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Tags Active Badges & Management -->
      <div class="space-y-3">
        <div>
          <div class="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            <span>已有标签：</span>
            <span class="text-[11px] font-normal text-slate-400">点击 ✕ 移除</span>
          </div>

          <div v-if="editingTagsList.length > 0" class="flex flex-wrap gap-1.5 p-2.5 bg-slate-50 dark:bg-slate-800/70 border border-slate-200/80 dark:border-slate-700 rounded-xl min-h-[42px]">
            <span
              v-for="t in editingTagsList"
              :key="'active-' + t"
              class="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-indigo-50 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 transition-colors"
            >
              <span>#{{ t }}</span>
              <button
                type="button"
                @click="removeTagFromEditingList(t)"
                class="w-3.5 h-3.5 rounded-full hover:bg-indigo-200 dark:hover:bg-indigo-800 flex items-center justify-center text-indigo-500 hover:text-indigo-800 dark:hover:text-white transition-colors cursor-pointer"
                title="移除该标签"
              >
                <X class="w-2.5 h-2.5" />
              </button>
            </span>
          </div>
          <div v-else class="p-3 bg-slate-50 dark:bg-slate-800/40 border border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-center text-xs text-slate-400">
            暂无标签，在下方输入或选择常用标签
          </div>
        </div>

        <!-- Add New Tag Input -->
        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            添加标签：
          </label>
          <div class="flex items-center gap-2">
            <div class="relative flex-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold">#</span>
              <input
                v-model="newTagInput"
                @keydown.enter.prevent="addTagToEditingList()"
                type="text"
                placeholder="输入标签名…"
                class="w-full pl-7 pr-3.5 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              />
            </div>
            <button
              type="button"
              @click="addTagToEditingList()"
              class="px-3.5 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-xs transition-colors cursor-pointer shrink-0 flex items-center gap-1"
            >
              <Plus class="w-3.5 h-3.5" />
              <span>添加</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Quick suggestion tags from existing library & Global Management -->
      <div v-if="allTags.length > 0" class="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
        <div class="flex items-center justify-between text-[11px] text-slate-400">
          <span>常用标签：</span>
        </div>
        <div class="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-1">
          <div
            v-for="t in allTags"
            :key="'suggest-' + t"
            class="inline-flex items-center rounded-lg border text-[11px] transition-colors overflow-hidden"
            :class="editingTagsList.includes(t)
              ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-950/60 dark:border-indigo-700 dark:text-indigo-300 font-semibold'
              : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200/80 dark:hover:bg-slate-700/80'"
          >
            <button
              type="button"
              @click="toggleTagInEditingList(t)"
              class="px-2 py-1 cursor-pointer flex items-center gap-1"
              :title="editingTagsList.includes(t) ? '点击取消为此博主关联此标签' : '点击为此博主添加此标签'"
            >
              <span>{{ editingTagsList.includes(t) ? '✓' : '+' }}</span>
              <span>#{{ t }}</span>
            </button>
            <!-- Global Delete Tag from entire system -->
            <button
              type="button"
              @click.stop="deleteGlobalTag(t)"
              class="px-1.5 py-1 text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition-colors border-l border-slate-200/60 dark:border-slate-700/60 cursor-pointer"
              title="移除该标签"
            >
              <Trash2 class="w-2.5 h-2.5" />
            </button>
          </div>
        </div>
      </div>

      <!-- Modal Footer -->
      <div class="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
        <button
          type="button"
          @click="emit('close')"
          class="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
        >
          取消
        </button>
        <button
          type="button"
          @click="save"
          class="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-xs cursor-pointer"
        >
          保存修改
        </button>
      </div>
    </div>
  </BaseModal>
</template>
