<script setup lang="ts">
import { AlertCircle } from 'lucide-vue-next';

defineProps<{
  manualUrl: string;
}>();

const emit = defineEmits<{
  'update:manualUrl': [value: string];
  parse: [];
}>();
</script>

<template>
  <!-- Unrecognized Page / Manual Add -->
  <div class="space-y-3">
    <div class="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 rounded-xl">
      <div class="flex items-center gap-1.5 text-amber-800 dark:text-amber-200 font-semibold mb-1">
        <AlertCircle class="w-4 h-4 text-amber-600" />
        <span>未识别到创作者</span>
      </div>
      <p class="text-[10px] text-amber-700 dark:text-amber-300">
        请导航到支持的创作者主页
      </p>
    </div>

    <div class="space-y-2">
      <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300">手动输入链接：</label>
      <div class="flex gap-1.5">
        <input
          :value="manualUrl"
          @input="emit('update:manualUrl', ($event.target as HTMLInputElement).value)"
          type="text"
          placeholder="https://space.bilibili.com/..."
          class="flex-1 px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500"
          @keyup.enter="emit('parse')"
        />
        <button
          @click="emit('parse')"
          class="px-3 py-1.5 bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 rounded-lg text-xs font-medium hover:opacity-90"
        >
          识别
        </button>
      </div>
    </div>
  </div>
</template>
