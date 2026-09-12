<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircle, HelpCircle } from 'lucide-vue-next';
import BaseModal from './BaseModal.vue';
import { activeDialog, settleDialog } from '../composables/useDialog';

/**
 * Renders the dialog currently requested through `useDialog` (audit P2-20).
 *
 * Mounted once in the dashboard shell. All the accessibility work (focus trap,
 * Escape, scroll lock, dialog semantics) comes from `BaseModal`; this component
 * only chooses the wording, the buttons and the flag.
 *
 * Escape and backdrop close are wired to the CANCEL answer, not to "dismiss":
 * for a `confirm` that must mean `false`, or pressing Escape on 「确定要删除吗？」
 * would read as consent.
 */
const current = computed(() => activeDialog.value);

function answer(value: boolean): void {
  const dialog = activeDialog.value;
  if (dialog) settleDialog(dialog.id, value);
}

const confirmLabel = computed(() => current.value?.confirmLabel
  ?? (current.value?.kind === 'confirm' ? '确定' : '知道了'));
</script>

<template>
  <BaseModal
    v-if="current"
    :key="current.id"
    overlay-class="bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50"
    @close="answer(false)"
  >
    <div
      role="alertdialog"
      :aria-label="current.title || (current.kind === 'confirm' ? '确认操作' : '提示')"
      class="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4"
    >
      <div class="flex items-start gap-3">
        <component
          :is="current.kind === 'confirm' ? HelpCircle : AlertCircle"
          class="w-5 h-5 shrink-0 mt-0.5"
          :class="current.kind === 'confirm' ? 'text-indigo-500' : 'text-slate-400'"
        />
        <div class="min-w-0 space-y-1">
          <h3 v-if="current.title" class="font-semibold text-sm text-slate-900 dark:text-white">
            {{ current.title }}
          </h3>
          <p class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-line break-words">{{ current.message }}</p>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 pt-1">
        <button
          v-if="current.kind === 'confirm'"
          type="button"
          class="px-3.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
          @click="answer(false)"
        >
          {{ current.cancelLabel || '取消' }}
        </button>
        <button
          type="button"
          class="px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-colors cursor-pointer"
          @click="answer(true)"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </BaseModal>
</template>
