<script setup lang="ts" generic="T extends string | number">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { ChevronDown, Check } from 'lucide-vue-next';

/**
 * 统一风格下拉选择器：替代原生 <select>。
 *
 * 原生 select 的下拉层由操作系统渲染，无法跟随 Tailwind 的圆角/边框/
 * 暗色主题，三处（创作者排序、设置页两个设置项）长期风格脱节。此组件
 * 自绘触发按钮与浮层，交互对齐仓库既有按钮样式。
 *
 * - 键盘可达：Enter/Space 展开，↑/↓ 移动，Enter 确认，Esc 关闭
 * - 点击外部关闭；浮层顶端对齐，向上展开（触发器都在卡片底部区域）
 *
 * 泛型 `T` 是必须的，不是装饰：此前 `modelValue` 声明为 `string | number`，
 * 而调用方绑定的是窄类型 ref（`CreatorSortKey`、`DevLogLevel | 'all'`、`number`），
 * 于是 `v-model` 可以把任意 string/number 写进一个更窄的 ref 而无人察觉。
 * 现在 `T` 由 `modelValue` 推断，`options` 必须与它同型。
 */
export interface AppSelectOption<V extends string | number = string | number> {
  value: V;
  label: string;
}

// `aria-*` reaches the button through attribute fallthrough rather than a prop.
// Declaring an `ariaLabel` prop looks equivalent but breaks tooling: `aria-label`
// is a native HTML attribute name, so `vue-tsc` refuses to map it onto a declared
// prop (`menu-placement` → `menuPlacement` maps fine by comparison), and the call
// sites then fail typecheck for a label that works perfectly at runtime. Keeping
// it an attribute means the call sites stay idiomatic AND strictTemplates can be
// on. The root is a wrapper <div>, so `$attrs` is bound to the button explicitly —
// an `aria-label` on the div would name nothing.
defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue: T;
    options: AppSelectOption<T>[];
    /** 触发按钮额外类（尺寸随调用方）。 */
    buttonClass?: string;
    disabled?: boolean;
    /** 左侧图标（lucide 组件）。 */
    icon?: unknown;
    /**
     * 浮层展开方向。默认向上（`top`），因为大多数触发器位于卡片底部区域；
     * 位于面板顶部（如开发者日志的筛选行）时应改为 `bottom`，否则浮层会盖住标题。
     */
    menuPlacement?: 'top' | 'bottom';
  }>(),
  { buttonClass: 'px-3 py-1.5 text-xs', menuPlacement: 'top' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
}>();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const activeIndex = ref(0);

const selectedLabel = () =>
  props.options.find((o) => o.value === props.modelValue)?.label ?? String(props.modelValue);

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    activeIndex.value = Math.max(
      0,
      props.options.findIndex((o) => o.value === props.modelValue),
    );
  }
}

function select(option: AppSelectOption<T>) {
  emit('update:modelValue', option.value);
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (e.key === 'Escape' && open.value) {
    open.value = false;
    return;
  }
  if (!open.value && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    toggle();
    return;
  }
  if (!open.value) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % props.options.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + props.options.length) % props.options.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    select(props.options[activeIndex.value]);
  }
}

function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener('mousedown', onDocClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick));
</script>

<template>
  <div ref="rootEl" class="relative inline-block text-left" @keydown="onKeydown">
    <button
      type="button"
      v-bind="$attrs"
      :disabled="disabled"
      :aria-expanded="open"
      @click="toggle"
      class="inline-flex items-center justify-between gap-1.5 font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
      :class="buttonClass"
    >
      <span class="inline-flex items-center gap-1.5 min-w-0 truncate">
        <component :is="icon" v-if="icon" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span class="truncate">{{ selectedLabel() }}</span>
      </span>
      <ChevronDown class="w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform duration-200" :class="{ 'rotate-180': open }" />
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="open"
        class="absolute z-50 min-w-full w-max max-w-64 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-lg py-1"
        :class="menuPlacement === 'bottom' ? 'top-full mt-1.5 left-0' : 'bottom-full mb-1.5 left-0'"
      >
        <button
          v-for="(option, i) in options"
          :key="option.value"
          type="button"
          @click="select(option)"
          @mouseenter="activeIndex = i"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center justify-between gap-2 cursor-pointer transition-colors"
          :class="i === activeIndex ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-slate-600 dark:text-slate-300'"
        >
          <span class="truncate">{{ option.label }}</span>
          <Check v-if="option.value === modelValue" class="w-3 h-3 text-indigo-500 shrink-0" />
        </button>
      </div>
    </Transition>
  </div>
</template>
