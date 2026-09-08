<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';

/**
 * 共享模态弹窗外壳：统一无障碍与交互行为。
 *
 * - `role="dialog"` + `aria-modal="true"`
 * - 焦点圈定（Tab / Shift+Tab 在弹窗内循环，卸载时恢复原焦点）
 * - Escape 关闭（可通过 `closeOnEscape` 禁用）
 * - 遮罩点击关闭（可通过 `closeOnBackdrop` 禁用）
 * - 挂载期间锁定 body 滚动，卸载时恢复
 *
 * 采用「挂载即打开」模型：父组件用 `v-if` 控制挂载/卸载，
 * 关闭时通过 `@close` 事件自行卸载。
 */
const props = withDefaults(defineProps<{
  /** 点击遮罩（overlay 自身）时是否触发 close。 */
  closeOnBackdrop?: boolean;
  /** 按下 Escape 时是否触发 close。 */
  closeOnEscape?: boolean;
  /** 附加到遮罩层的 class（背景色 / 模糊 / 布局等），与默认 class 合并。 */
  overlayClass?: string;
}>(), {
  closeOnBackdrop: true,
  closeOnEscape: true,
});

const emit = defineEmits<{
  close: [];
}>();

const overlayEl = ref<HTMLElement | null>(null);
/** 挂载前保存的 body overflow 值，卸载时恢复。 */
let savedBodyOverflow = '';
/** 挂载前保存的焦点元素，卸载时恢复。 */
let savedActiveElement: Element | null = null;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(): HTMLElement[] {
  if (!overlayEl.value) return [];
  return Array.from(overlayEl.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function focusFirstElement(): void {
  const focusables = getFocusableElements();
  if (focusables.length > 0) {
    focusables[0].focus();
  } else {
    overlayEl.value?.focus();
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (props.closeOnEscape) {
      event.stopPropagation();
      emit('close');
    }
    return;
  }
  if (event.key === 'Tab') {
    const focusables = getFocusableElements();
    if (focusables.length === 0) {
      event.preventDefault();
      overlayEl.value?.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || active === overlayEl.value || !overlayEl.value?.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || active === overlayEl.value || !overlayEl.value?.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }
}

function handleOverlayClick(): void {
  if (props.closeOnBackdrop) emit('close');
}

onMounted(() => {
  savedActiveElement = document.activeElement;
  savedBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  nextTick(() => focusFirstElement());
});

onUnmounted(() => {
  document.body.style.overflow = savedBodyOverflow;
  if (savedActiveElement instanceof HTMLElement) {
    savedActiveElement.focus();
  }
});
</script>

<template>
  <div
    ref="overlayEl"
    class="fixed inset-0 z-50"
    :class="overlayClass"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    @keydown="handleKeydown"
    @click.self="handleOverlayClick"
  >
    <slot />
  </div>
</template>
