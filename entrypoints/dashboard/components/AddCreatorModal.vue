<script setup lang="ts">
import { ref, computed } from 'vue';
import { Search, X, CheckCircle2, Sparkles } from 'lucide-vue-next';
import { PLATFORM_REGISTRY, type Creator, type Channel } from '../../../src/types';
import { toSecureMediaUrl } from '../../../src/utils/media';
import { parseProfileUrl } from '../../../src/utils/urlParser';
import type { AddModalOpenRequest, AddModalSubmitPayload, AddModalRole } from '../types/modal';


const props = defineProps<{
  /** 打开弹窗时的初始请求（每次打开由父层重新生成，组件挂载时据此复位表单）。 */
  request: AddModalOpenRequest;
  creators: Creator[];
  channels: Channel[];
  /** 提交中（父层异步落库期间显示“添加中…”并禁用按钮）。 */
  submitting: boolean;
}>();
const emit = defineEmits<{
  close: [];
  submit: [payload: AddModalSubmitPayload];
}>();

const secure = toSecureMediaUrl;

// ---- Form state (local; reset on each open, mirroring the former App.vue fields) ----
const mode = ref<'new' | 'channel'>('new');
const creatorId = ref('');
const isEditingCreatorSelection = ref(true);
const creatorSearchQuery = ref('');
const url = ref('');
const name = ref('');
const tags = ref('');
const role = ref<AddModalRole>('main');
const customLabel = ref('');

const selectedCreator = ref<Creator | null>(null);

function resetFromRequest() {
  const { mode: m, creator, initialUrl } = props.request;
  mode.value = m;
  selectedCreator.value = creator;
  url.value = initialUrl;
  name.value = '';
  tags.value = '';
  role.value = m === 'channel' ? 'sub' : 'main';
  customLabel.value = '';
  creatorId.value = creator ? creator.id : (props.creators[0]?.id || '');
  isEditingCreatorSelection.value = !creator;
  creatorSearchQuery.value = '';
}
resetFromRequest();

const selectedCreatorObj = computed(() => {
  return props.creators.find(c => c.id === creatorId.value);
});

const filteredCandidateCreators = computed(() => {
  const q = creatorSearchQuery.value.trim().toLowerCase();
  if (!q) return props.creators;
  return props.creators.filter(c => {
    const matchName = c.name.toLowerCase().includes(q);
    const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
    const matchNote = c.note?.toLowerCase().includes(q);
    const matchId = c.id.toLowerCase().includes(q);
    return matchName || matchTag || matchNote || matchId;
  });
});

const existingMatchingCreators = computed(() => {
  if (mode.value !== 'new' || !name.value.trim()) return [];
  const q = name.value.trim().toLowerCase();
  return props.creators.filter(c => {
    const matchName = c.name.toLowerCase().includes(q);
    const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
    const matchNote = c.note?.toLowerCase().includes(q);
    const matchId = c.id.toLowerCase().includes(q);
    return matchName || matchTag || matchNote || matchId;
  });
});

const detectedParsedProfile = computed(() => {
  if (!url.value.trim()) return null;
  return parseProfileUrl(url.value);
});

const detectedSamePlatformAccounts = computed(() => {
  if (!url.value.trim()) return [];
  const parsed = detectedParsedProfile.value;
  if (!parsed) return [];
  const cid = mode.value === 'channel' ? (selectedCreator.value?.id || creatorId.value) : creatorId.value;
  if (!cid) return [];
  return props.channels.filter(ch => ch.creatorId === cid && ch.platform === parsed.platform);
});

function selectCreator(c: Creator) {
  creatorId.value = c.id;
  selectedCreator.value = c;
  isEditingCreatorSelection.value = false;
  creatorSearchQuery.value = '';
}

function switchToNewCreatorWithQuery(q: string) {
  mode.value = 'new';
  if (q) name.value = q;
  creatorId.value = '';
  selectedCreator.value = null;
}

function bindExistingCreator(c: Creator) {
  mode.value = 'channel';
  selectCreator(c);
}

function submit() {
  emit('submit', {
    mode: mode.value,
    url: url.value,
    creatorId: creatorId.value,
    name: name.value,
    tags: tags.value,
    role: role.value,
    customLabel: customLabel.value,
  });
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
  >
    <div class="w-full max-w-md bg-white dark:bg-slate-900 rounded-3xl p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
          <button
            type="button"
            @click="mode = 'new'"
            :class="mode === 'new' ? 'bg-white dark:bg-slate-700 shadow-2xs text-indigo-600 dark:text-indigo-300 font-bold' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'"
            class="px-2.5 py-1 text-xs rounded-lg transition-all cursor-pointer"
          >
            新建创作者
          </button>
          <button
            type="button"
            @click="mode = 'channel'"
            :class="mode === 'channel' ? 'bg-white dark:bg-slate-700 shadow-2xs text-indigo-600 dark:text-indigo-300 font-bold' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'"
            class="px-2.5 py-1 text-xs rounded-lg transition-all cursor-pointer"
          >
            绑定现有创作者
          </button>
        </div>
        <button @click="emit('close')" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-sm cursor-pointer p-1">
          ✕
        </button>
      </div>

      <div class="space-y-3 text-xs">
        <!-- Searchable Creator Selection Combobox when in channel mode -->
        <div v-if="mode === 'channel'" class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="block font-medium text-slate-700 dark:text-slate-300">选择创作者</label>
            <span class="text-[10px] text-slate-400">支持搜索</span>
          </div>

          <!-- Case A: Creator is chosen and not currently searching/editing -->
          <div
            v-if="selectedCreatorObj && !isEditingCreatorSelection"
            class="flex items-center justify-between p-2.5 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800 rounded-xl"
          >
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-8 h-8 rounded-xl bg-indigo-100 dark:bg-indigo-900/60 flex items-center justify-center font-bold text-xs text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 border border-indigo-200 dark:border-indigo-800">
                <img v-if="selectedCreatorObj.avatar" :src="secure(selectedCreatorObj.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                <span v-else>{{ selectedCreatorObj.name.slice(0, 1) }}</span>
              </div>
              <div class="min-w-0">
                <div class="font-bold text-xs text-slate-900 dark:text-white truncate">
                  {{ selectedCreatorObj.name }}
                </div>
                <div class="flex items-center gap-1 mt-0.5">
                  <span class="text-[10px] text-slate-500 dark:text-slate-400">
                    已绑 {{ channels.filter(ch => ch.creatorId === selectedCreatorObj.id).length }} 个账号
                  </span>
                  <span v-for="t in selectedCreatorObj.tags?.slice(0, 2)" :key="t" class="text-[9px] px-1 py-0.2 rounded bg-white dark:bg-slate-800 text-slate-500 border border-slate-200/60 dark:border-slate-700">
                    #{{ t }}
                  </span>
                </div>
              </div>
            </div>
            <button
              type="button"
              @click="isEditingCreatorSelection = true"
              class="px-2.5 py-1 text-xs text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-semibold bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer shrink-0"
            >
              更换
            </button>
          </div>

          <!-- Case B: Search input & live match dropdown -->
          <div v-else class="space-y-1">
            <div class="relative">
              <Search class="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-400" />
              <input
                v-model="creatorSearchQuery"
                type="text"
                placeholder="搜索创作者..."
                class="w-full pl-8.5 pr-8 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                autofocus
              />
              <button
                v-if="creatorSearchQuery"
                type="button"
                @click="creatorSearchQuery = ''"
                class="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>

            <!-- Candidate Results List -->
            <div class="max-h-44 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-md divide-y divide-slate-100 dark:divide-slate-700/60">
              <div
                v-for="c in filteredCandidateCreators"
                :key="c.id"
                @click="selectCreator(c)"
                class="p-2 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700/60 cursor-pointer transition-colors"
                :class="{ 'bg-indigo-50/50 dark:bg-indigo-950/40': creatorId === c.id }"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <div class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-[11px] text-indigo-600 overflow-hidden shrink-0 border border-slate-200 dark:border-slate-600">
                    <img v-if="c.avatar" :src="secure(c.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                    <span v-else>{{ c.name.slice(0, 1) }}</span>
                  </div>
                  <div class="min-w-0">
                    <div class="font-bold text-xs text-slate-800 dark:text-slate-100 truncate flex items-center gap-1.5">
                      <span>{{ c.name }}</span>
                      <CheckCircle2 v-if="creatorId === c.id" class="w-3 h-3 text-indigo-600 shrink-0" />
                    </div>
                    <div class="flex items-center gap-1 text-[10px] text-slate-400 truncate">
                      <span>已绑 {{ channels.filter(ch => ch.creatorId === c.id).length }} 个账号</span>
                      <span v-for="t in c.tags?.slice(0, 2)" :key="t" class="px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-700 text-slate-500">#{{ t }}</span>
                    </div>
                  </div>
                </div>
                <span class="text-[11px] text-indigo-600 dark:text-indigo-400 font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60">选择</span>
              </div>

              <!-- No match state -->
              <div v-if="filteredCandidateCreators.length === 0" class="p-3 text-center text-xs text-slate-400 space-y-1.5">
                <div>未找到 "{{ creatorSearchQuery }}"</div>
                <button
                  type="button"
                  @click="switchToNewCreatorWithQuery(creatorSearchQuery)"
                  class="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold cursor-pointer"
                >
                  + 新建创作者「{{ creatorSearchQuery }}」
                </button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <label class="block font-medium text-slate-700 dark:text-slate-300 mb-1">创作者链接</label>
          <input
            v-model="url"
            type="text"
            placeholder="粘贴主页链接、视频链接或 RSS 地址"
            class="w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
          />

          <!-- Real-time Parsed Platform & Account Identifier Preview -->
          <div
            v-if="detectedParsedProfile"
            class="mt-2 p-2.5 bg-slate-50 dark:bg-slate-800/80 rounded-xl border border-slate-200 dark:border-slate-700/80 flex items-center justify-between gap-2"
          >
            <div class="flex items-center gap-2 min-w-0">
              <span
                :class="PLATFORM_REGISTRY[detectedParsedProfile.platform]?.badgeBg"
                class="px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0"
              >
                {{ PLATFORM_REGISTRY[detectedParsedProfile.platform]?.name }}
              </span>
              <div class="min-w-0">
                <div class="font-bold text-xs text-slate-800 dark:text-slate-100 truncate">
                  {{ detectedParsedProfile.suggestedName || detectedParsedProfile.accountId }}
                </div>
                <div class="text-[10px] text-slate-400 truncate flex items-center gap-1">
                  <span>ID:</span>
                  <span class="font-mono text-slate-600 dark:text-slate-300">{{ detectedParsedProfile.accountId }}</span>
                </div>
              </div>
            </div>
            <span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold shrink-0">✓ 已识别</span>
          </div>
        </div>

        <!-- Same platform multi-account hint -->
        <div
          v-if="detectedSamePlatformAccounts.length > 0"
          class="p-2.5 bg-sky-50 dark:bg-sky-950/40 rounded-xl border border-sky-200 dark:border-sky-800/60 text-[11px] text-sky-800 dark:text-sky-200 flex items-start gap-2"
        >
          <Sparkles class="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5" />
          <div>
            该创作者已有同平台账号（{{ detectedSamePlatformAccounts[0].displayName || detectedSamePlatformAccounts[0].accountId }}），本次将作为小号/副号一并绑定。
          </div>
        </div>

        <!-- Account Role / Purpose Selection -->
        <div>
          <label class="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">账号类型</label>
          <div class="grid grid-cols-4 gap-1.5">
            <button
              type="button"
              @click="role = 'main'"
              :class="role === 'main' ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
              class="py-1.5 text-[11px] rounded-lg border transition-all cursor-pointer text-center"
            >
              主账号
            </button>
            <button
              type="button"
              @click="role = 'sub'"
              :class="role === 'sub' ? 'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
              class="py-1.5 text-[11px] rounded-lg border transition-all cursor-pointer text-center"
            >
              小号
            </button>
            <button
              type="button"
              @click="role = 'alt'"
              :class="role === 'alt' ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/80 dark:text-rose-300 dark:border-rose-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
              class="py-1.5 text-[11px] rounded-lg border transition-all cursor-pointer text-center"
            >
              里号
            </button>
            <button
              type="button"
              @click="role = 'custom'"
              :class="role === 'custom' ? 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-950/80 dark:text-purple-300 dark:border-purple-700 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
              class="py-1.5 text-[11px] rounded-lg border transition-all cursor-pointer text-center"
            >
              自定义
            </button>
          </div>
          <!-- Custom Label Input if custom role selected -->
          <div v-if="role === 'custom'" class="mt-2">
            <input
              v-model="customLabel"
              type="text"
              placeholder="输入自定义标签"
              class="w-full px-3 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        </div>

        <div v-if="mode === 'new'">
          <label class="block font-medium text-slate-700 dark:text-slate-300 mb-1">创作者名称</label>
          <input
            v-model="name"
            type="text"
            placeholder="如：爱丽丝 / Alice"
            class="w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <!-- Smart suggestion cards when typing an existing creator name -->
          <div
            v-if="existingMatchingCreators.length > 0"
            class="mt-1.5 p-2 bg-indigo-50/90 dark:bg-indigo-950/60 border border-indigo-200/80 dark:border-indigo-800 rounded-xl space-y-1.5"
          >
            <div class="flex items-center justify-between text-[11px] text-indigo-800 dark:text-indigo-300 font-medium">
              <span>已有创作者：</span>
              <span class="text-[10px] text-indigo-500">点击绑定</span>
            </div>
            <div class="space-y-1 max-h-36 overflow-y-auto">
              <div
                v-for="c in existingMatchingCreators"
                :key="c.id"
                @click="bindExistingCreator(c)"
                class="p-1.5 bg-white dark:bg-slate-800 rounded-lg border border-indigo-100 dark:border-indigo-900/60 flex items-center justify-between gap-2 hover:bg-indigo-100/50 dark:hover:bg-slate-700 cursor-pointer transition-colors shadow-2xs"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <div class="w-6 h-6 rounded-lg bg-indigo-100 dark:bg-indigo-900/60 flex items-center justify-center font-bold text-[10px] text-indigo-600 dark:text-indigo-300 overflow-hidden shrink-0 border border-indigo-200 dark:border-indigo-800">
                    <img v-if="c.avatar" :src="secure(c.avatar)" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
                    <span v-else>{{ c.name.slice(0, 1) }}</span>
                  </div>
                  <div class="min-w-0">
                    <div class="font-bold text-xs text-slate-900 dark:text-white truncate">
                      {{ c.name }}
                    </div>
                    <div class="text-[9px] text-slate-400 truncate">
                      已绑 {{ channels.filter(ch => ch.creatorId === c.id).length }} 个账号
                      <span v-for="t in c.tags?.slice(0, 2)" :key="t" class="ml-1 px-1 rounded bg-slate-100 dark:bg-slate-700">#{{ t }}</span>
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

        <div v-if="mode === 'new'">
          <label class="block font-medium text-slate-700 dark:text-slate-300 mb-1">标签（逗号分隔）</label>
          <input
            v-model="tags"
            type="text"
            placeholder="如：ASMR, 插画, 游戏"
            class="w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
        <button
          @click="emit('close')"
          class="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
        >
          取消
        </button>
        <button
          @click="submit"
          :disabled="submitting || !url.trim()"
          class="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-xl shadow-xs cursor-pointer"
        >
          {{ submitting ? '添加中...' : '确认添加' }}
        </button>
      </div>
    </div>
  </div>
</template>
