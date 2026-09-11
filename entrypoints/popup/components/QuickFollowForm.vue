<script setup lang="ts">
import { computed } from 'vue';
import { CheckCircle2, PlusCircle, Search, X } from 'lucide-vue-next';
import type { Channel, Creator } from '../../../src/types';
import { toSecureMediaUrl } from '../../../src/utils/media';
import type { AccountRole, FollowMode } from '../composables/useQuickFollow';

const props = defineProps<{
  mode: FollowMode;
  creators: Creator[];
  channels: Channel[];
  newCreatorName: string;
  newCreatorTags: string;
  creatorSearchQuery: string;
  isEditingCreatorSelection: boolean;
  selectedCreatorId: string;
  selectedCreatorObj: Creator | null;
  accountRole: AccountRole;
  customLabel: string;
  saving: boolean;
  matchedExistingCreators: Creator[];
  filteredCandidateCreators: Creator[];
  samePlatformAccounts: Channel[];
}>();

const emit = defineEmits<{
  'update:mode': [mode: FollowMode];
  'update:newCreatorName': [value: string];
  'update:newCreatorTags': [value: string];
  'update:creatorSearchQuery': [value: string];
  'update:isEditingCreatorSelection': [value: boolean];
  'update:accountRole': [role: AccountRole];
  'update:customLabel': [value: string];
  select: [creator: Creator];
  switchNew: [name?: string];
  save: [];
}>();

const allExistingTags = computed(() => {
  const set = new Set<string>();
  props.creators.forEach(c => {
    c.tags?.forEach(t => {
      const trimmed = t.trim();
      if (trimmed) set.add(trimmed);
    });
  });
  return Array.from(set);
});

const parsedSelectedTags = computed(() => {
  return (props.newCreatorTags || '')
    .split(/[,，]/)
    .map(t => t.trim())
    .filter(Boolean);
});

function toggleTag(tag: string) {
  const current = parsedSelectedTags.value;
  let next: string[];
  if (current.includes(tag)) {
    next = current.filter(t => t !== tag);
  } else {
    next = [...current, tag];
  }
  emit('update:newCreatorTags', next.join(', '));
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
      <button
        @click="emit('update:mode', 'new')"
        :class="mode === 'new' ? 'bg-white dark:bg-slate-700 shadow-xs text-slate-900 dark:text-white font-medium' : 'text-slate-500'"
        class="flex-1 py-1 text-center rounded-md text-[11px] transition-all cursor-pointer"
      >
        新建创作者
      </button>
      <button
        @click="emit('update:mode', 'bind')"
        :disabled="creators.length === 0"
        :class="mode === 'bind' ? 'bg-white dark:bg-slate-700 shadow-xs text-slate-900 dark:text-white font-medium' : 'text-slate-500'"
        class="flex-1 py-1 text-center rounded-md text-[11px] transition-all disabled:opacity-40 cursor-pointer"
      >
        绑定到已有 ({{ creators.length }})
      </button>
    </div>

    <!-- Mode: New Creator -->
    <div v-if="mode === 'new'" class="space-y-2">
      <div>
        <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">创作者名称</label>
        <div class="relative">
          <input
            :value="newCreatorName"
            @input="emit('update:newCreatorName', ($event.target as HTMLInputElement).value)"
            type="text"
            placeholder="例如：爱丽丝 / Alice"
            class="w-full px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 outline-none"
          />
        </div>

        <!-- Associated existing creators live suggestions -->
        <div
          v-if="matchedExistingCreators.length > 0"
          class="mt-1.5 p-2 bg-indigo-50/90 dark:bg-indigo-950/60 border border-indigo-200/80 dark:border-indigo-800 rounded-xl space-y-1.5"
        >
          <div class="flex items-center justify-between text-[11px] text-indigo-800 dark:text-indigo-300 font-medium">
            <span>已有创作者：</span>
            <span class="text-[10px] text-indigo-500">点击绑定</span>
          </div>
          <div class="space-y-1 max-h-32 overflow-y-auto">
            <div
              v-for="c in matchedExistingCreators"
              :key="c.id"
              @click="emit('select', c)"
              class="p-1.5 bg-white dark:bg-slate-800 rounded-lg border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-between gap-2 hover:bg-indigo-100/50 dark:hover:bg-slate-700 cursor-pointer transition-colors shadow-2xs"
            >
              <div class="flex items-center gap-2 min-w-0">
                <div class="w-6 h-6 rounded-lg bg-indigo-100 dark:bg-indigo-900/60 flex items-center justify-center font-bold text-[10px] text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 border border-indigo-200 dark:border-indigo-800">
                  <img v-if="c.avatar" :src="toSecureMediaUrl(c.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                  <span v-else>{{ c.name.slice(0, 1) }}</span>
                </div>
                <div class="min-w-0">
                  <div class="font-bold text-xs text-slate-900 dark:text-white truncate">
                    {{ c.name }}
                  </div>
                  <div class="text-[9px] text-slate-400 truncate">
                    已绑 {{ channels.filter(ch => ch.creatorId === c.id).length }} 个账号
                    <span v-for="t in c.tags?.slice(0, 1)" :key="t" class="ml-1 px-1 rounded bg-slate-100 dark:bg-slate-700">#{{ t }}</span>
                  </div>
                </div>
              </div>
              <span class="text-[10px] text-indigo-600 dark:text-indigo-400 font-bold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/80 shrink-0">
                绑定 →
              </span>
            </div>
          </div>
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between mb-1">
          <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300">标签（逗号分隔）</label>
          <span v-if="allExistingTags.length > 0" class="text-[10px] text-slate-400">点击标签快速选择</span>
        </div>
        <input
          :value="newCreatorTags"
          @input="emit('update:newCreatorTags', ($event.target as HTMLInputElement).value)"
          type="text"
          placeholder="例如：ASMR, 插画, 游戏"
          class="w-full px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 outline-none"
        />

        <!-- Clickable existing tags pill list -->
        <div v-if="allExistingTags.length > 0" class="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            v-for="t in allExistingTags"
            :key="t"
            type="button"
            @click="toggleTag(t)"
            :class="parsedSelectedTags.includes(t)
              ? 'bg-indigo-600 text-white font-medium border-indigo-600 shadow-2xs'
              : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 border-slate-200/60 dark:border-slate-700/60'"
            class="px-2 py-0.5 rounded-md text-[10px] border transition-all cursor-pointer flex items-center gap-0.5 select-none"
          >
            <span v-if="parsedSelectedTags.includes(t)" class="text-[9px] font-bold">✓</span>
            <span>#{{ t }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Mode: Bind Existing -->
    <div v-else class="space-y-2">
      <div>
        <div class="flex items-center justify-between mb-1">
          <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300">选择创作者</label>
          <span class="text-[10px] text-slate-400">可搜索</span>
        </div>

        <!-- Case A: Selected creator card -->
        <div
          v-if="selectedCreatorObj && !isEditingCreatorSelection"
          class="flex items-center justify-between p-2 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800 rounded-xl"
        >
          <div class="flex items-center gap-2 min-w-0">
            <div class="w-7 h-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/60 flex items-center justify-center font-bold text-[11px] text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 border border-indigo-200 dark:border-indigo-800">
              <img v-if="selectedCreatorObj.avatar" :src="toSecureMediaUrl(selectedCreatorObj.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
              <span v-else>{{ selectedCreatorObj.name.slice(0, 1) }}</span>
            </div>
            <div class="min-w-0">
              <div class="font-bold text-xs text-slate-900 dark:text-white truncate">
                {{ selectedCreatorObj.name }}
              </div>
              <div class="text-[9px] text-slate-500 dark:text-slate-400 truncate">
                已绑 {{ channels.filter(ch => ch.creatorId === selectedCreatorObj?.id).length }} 个账号
                <span v-for="t in selectedCreatorObj.tags?.slice(0, 2)" :key="t" class="ml-1 px-1 rounded bg-white dark:bg-slate-800 text-slate-500 border border-slate-200/60 dark:border-slate-700">#{{ t }}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            @click="emit('update:isEditingCreatorSelection', true)"
            class="px-2 py-0.5 text-[11px] text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-semibold bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer shrink-0"
          >
            更换
          </button>
        </div>

        <!-- Case B: Search input & candidate dropdown -->
        <div v-else class="space-y-1">
          <div class="relative">
            <Search class="absolute left-2.5 top-2 w-3 h-3 text-slate-400" />
            <input
              :value="creatorSearchQuery"
              @input="emit('update:creatorSearchQuery', ($event.target as HTMLInputElement).value)"
              type="text"
              placeholder="输入姓名 / 拼音 / 标签关键词搜索…"
              class="w-full pl-7.5 pr-7 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500"
              autofocus
            />
            <button
              v-if="creatorSearchQuery"
              type="button"
              @click="emit('update:creatorSearchQuery', '')"
              class="absolute right-2 top-2 text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              <X class="w-3 h-3" />
            </button>
          </div>

          <div class="max-h-36 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-700/60 shadow-xs">
            <div
              v-for="c in filteredCandidateCreators"
              :key="c.id"
              @click="emit('select', c)"
              class="p-1.5 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700/60 cursor-pointer transition-colors"
              :class="{ 'bg-indigo-50/50 dark:bg-indigo-950/40': selectedCreatorId === c.id }"
            >
              <div class="flex items-center gap-2 min-w-0">
                <div class="w-6 h-6 rounded bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-[10px] text-indigo-600 overflow-hidden shrink-0 border border-slate-200 dark:border-slate-600">
                  <img v-if="c.avatar" :src="toSecureMediaUrl(c.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                  <span v-else>{{ c.name.slice(0, 1) }}</span>
                </div>
                <div class="min-w-0">
                  <div class="font-bold text-xs text-slate-800 dark:text-slate-100 truncate flex items-center gap-1">
                    <span>{{ c.name }}</span>
                    <CheckCircle2 v-if="selectedCreatorId === c.id" class="w-2.5 h-2.5 text-indigo-600 shrink-0" />
                  </div>
                  <div class="text-[9px] text-slate-400 truncate">
                    已绑 {{ channels.filter(ch => ch.creatorId === c.id).length }} 号
                    <span v-for="t in c.tags?.slice(0, 1)" :key="t" class="ml-1 text-slate-500">#{{ t }}</span>
                  </div>
                </div>
              </div>
              <span class="text-[10px] text-indigo-600 dark:text-indigo-400 font-semibold px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60">选择</span>
            </div>

            <div v-if="filteredCandidateCreators.length === 0" class="p-2.5 text-center text-xs text-slate-400 space-y-1">
              <div>未找到 "{{ creatorSearchQuery }}"</div>
              <button
                type="button"
                @click="emit('switchNew', creatorSearchQuery)"
                class="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold cursor-pointer text-[11px]"
              >
                + 新建创作者「{{ creatorSearchQuery }}」
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Same Platform Hint -->
      <div
        v-if="samePlatformAccounts.length > 0"
        class="p-2 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800/60 rounded-lg text-[10px] text-sky-800 dark:text-sky-200 leading-tight"
      >
        该创作者已有同平台账号（{{ samePlatformAccounts[0].displayName || samePlatformAccounts[0].accountId }}），本次将作为副号绑定。
      </div>
    </div>

    <!-- Account Role / Tag selector (Common to both modes) -->
    <div class="space-y-1.5 pt-1 border-t border-slate-100 dark:border-slate-800">
      <label class="block text-[11px] font-medium text-slate-700 dark:text-slate-300">账号类型：</label>
      <div class="grid grid-cols-4 gap-1">
        <button
          type="button"
          @click="emit('update:accountRole', 'main')"
          :class="accountRole === 'main' ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
          class="py-1 text-[10px] rounded border transition-all cursor-pointer text-center"
        >
          主账号
        </button>
        <button
          type="button"
          @click="emit('update:accountRole', 'sub')"
          :class="accountRole === 'sub' ? 'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
          class="py-1 text-[10px] rounded border transition-all cursor-pointer text-center"
        >
          小号
        </button>
        <button
          type="button"
          @click="emit('update:accountRole', 'alt')"
          :class="accountRole === 'alt' ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/80 dark:text-rose-300 dark:border-rose-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
          class="py-1 text-[10px] rounded border transition-all cursor-pointer text-center"
        >
          里号
        </button>
        <button
          type="button"
          @click="emit('update:accountRole', 'custom')"
          :class="accountRole === 'custom' ? 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-950/80 dark:text-purple-300 dark:border-purple-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
          class="py-1 text-[10px] rounded border transition-all cursor-pointer text-center"
        >
          自定义
        </button>
      </div>
      <div v-if="accountRole === 'custom'" class="mt-1">
        <input
          :value="customLabel"
          @input="emit('update:customLabel', ($event.target as HTMLInputElement).value)"
          type="text"
          placeholder="例如：剪辑熟肉、直播回放"
          class="w-full px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>
    </div>

    <!-- Confirm Button -->
    <button
      @click="emit('save')"
      :disabled="saving"
      class="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
    >
      <PlusCircle class="w-3.5 h-3.5" />
      <span>{{ saving ? '添加中…' : '确认关注' }}</span>
    </button>
  </div>
</template>
