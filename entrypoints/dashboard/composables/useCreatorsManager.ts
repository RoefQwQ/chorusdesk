import { ref, type Ref, type ShallowRef } from 'vue';
import type { Creator, Channel, Post, AccountRole } from '../../../src/types';
import { ACCOUNT_ROLE_LABELS, ACCOUNT_ROLE_ORDER } from '../../../src/types';
import { creatorService, channelService, postService } from '../../../src/application';
import { updateChannel } from '../../../src/sync';
import { parseProfileUrl } from '../../../src/utils/urlParser';
import { errorMessage } from '../../../src/utils/errorMessage';
import { toSecureMediaUrl } from '../../../src/utils/media';
import type { AddModalOpenRequest, AddModalSubmitPayload } from '../types/modal';
import { dialog } from './useDialog';

export interface CreatorsManagerDependencies {
  creators: Ref<Creator[]>;
  channels: Ref<Channel[]>;
  posts: ShallowRef<Post[]>;
  /** Full dashboard reload (feed data + recycle-bin list). */
  reloadData: () => Promise<void>;
  /** Remove a tag from the active feed include/exclude filters (global tag purge). */
  clearTagFromFilters: (tag: string) => void;
}


/**
 * Creator entity lifecycle controller for the Dashboard: add/bind channel,
 * delete cascades, channel role cycling, avatar picker + fallback resolution,
 * tag editor persistence and global tag purge, plus demo seeding. Persistence
 * goes through the `src/application` services only — no Dexie or sync calls
 * live in this composable's callers. Behavior/text mirror the former App.vue
 * handlers exactly; only the location changed.
 */
export function useCreatorsManager(deps: CreatorsManagerDependencies) {
  const { channels, posts, reloadData, clearTagFromFilters } = deps;

  // ---- Add Creator / Bind Channel modal state ----
  const addModalOpenRequest = ref<AddModalOpenRequest | null>(null);
  const isSubmittingAdd = ref(false);

  function openAddModal(mode: 'new' | 'channel', creator?: Creator | null, initialUrl: string = '') {
    addModalOpenRequest.value = { mode, creator: creator ?? null, initialUrl };
  }

  // ---- Avatar picker + failed-URL memory (feed sidebar & avatar modal share this) ----
  const failedAvatarUrls = ref<Set<string>>(new Set());
  const avatarPickerCreator = ref<Creator | null>(null);

  function handleAvatarError(url?: string) {
    if (url) {
      failedAvatarUrls.value.add(url);
      failedAvatarUrls.value = new Set(failedAvatarUrls.value);
    }
  }

  function getCreatorAvatar(c?: Creator | null): string {
    if (!c) return '';
    if (c.avatar && c.avatar.trim().length > 0 && !failedAvatarUrls.value.has(c.avatar)) {
      return toSecureMediaUrl(c.avatar);
    }
    // Fallback 1: check channels of this creator
    const ch = channels.value.find(
      ch => ch.creatorId === c.id && ch.avatarUrl && ch.avatarUrl.trim().length > 0 && !failedAvatarUrls.value.has(ch.avatarUrl)
    );
    if (ch?.avatarUrl) {
      if (!c.avatar) {
        c.avatar = ch.avatarUrl;
        creatorService.update(c.id, { avatar: ch.avatarUrl }).catch(() => {});
      }
      return toSecureMediaUrl(ch.avatarUrl);
    }
    // Fallback 2: check posts of this creator
    const p = posts.value.find(
      p => p.creatorId === c.id && p.authorMeta?.avatar && p.authorMeta.avatar.trim().length > 0 && !failedAvatarUrls.value.has(p.authorMeta.avatar)
    );
    if (p?.authorMeta?.avatar) {
      if (!c.avatar) {
        c.avatar = p.authorMeta.avatar;
        creatorService.update(c.id, { avatar: p.authorMeta.avatar }).catch(() => {});
      }
      return toSecureMediaUrl(p.authorMeta.avatar);
    }
    return '';
  }

  function openAvatarPicker(creator: Creator) {
    avatarPickerCreator.value = creator;
  }

  async function selectPrimaryAvatar(creator: Creator, url: string) {
    const avatar = toSecureMediaUrl(url);
    await creatorService.update(creator.id, { avatar, primaryAvatarUrl: avatar, updatedAt: Date.now() });
    creator.avatar = avatar;
    creator.primaryAvatarUrl = avatar;
    avatarPickerCreator.value = null;
  }

  // ---- Account role & multi-account grouping helpers ----
  function getRoleLabel(role?: string, label?: string) {
    if (label) return label;
    return ACCOUNT_ROLE_LABELS[(role as AccountRole) || 'main'] || ACCOUNT_ROLE_LABELS.main;
  }

  async function cycleChannelRole(ch: Channel) {
    const currentIndex = ACCOUNT_ROLE_ORDER.indexOf(ch.accountRole || 'main');
    const nextRole = ACCOUNT_ROLE_ORDER[(currentIndex + 1) % ACCOUNT_ROLE_ORDER.length];
    ch.accountRole = nextRole;
    ch.label = getRoleLabel(nextRole);
    await channelService.setRole(ch);
    await reloadData();
  }

  // ---- Add creator / bind existing creator ----
  async function submitAdd(payload: AddModalSubmitPayload) {
    const urlValue = payload.url.trim();
    if (!urlValue) return;
    isSubmittingAdd.value = true;

    try {
      const parsed = parseProfileUrl(urlValue);
      if (!parsed) {
        await dialog.alert('无法识别该网址，请确保输入支持的创作者主页、作品链接或 RSS 源。');
        return;
      }

      let creatorId = payload.creatorId;

      if (payload.mode === 'new' || !creatorId) {
        const typedName = payload.name.trim();
        const newCreator: Creator = {
          id: 'c_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
          name: typedName || parsed.suggestedName || '未命名创作者',
          // A typed name belongs to the user; anything from `suggestedName` is
          // ours and may be replaced by the platform's real nickname.
          nameSource: typedName ? 'user' : 'generated',
          avatar: '',
          tags: payload.tags.split(/[,，\s]+/).filter(Boolean),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await creatorService.save(newCreator);
        creatorId = newCreator.id;
      }

      const channelId = `${parsed.platform}:${parsed.accountId}`;
      const roleLabel = payload.role === 'custom'
        ? (payload.customLabel.trim() || '自定义频道')
        : getRoleLabel(payload.role);

      const newChannel: Channel = {
        id: channelId,
        creatorId,
        platform: parsed.platform,
        accountId: parsed.accountId,
        displayName: parsed.suggestedName || parsed.accountId,
        // There is no "let the user name a channel" flow, so a new channel's
        // name is always ours to replace with the platform's own.
        nameSource: 'generated',
        profileUrl: parsed.cleanUrl,
        label: roleLabel,
        accountRole: payload.role,
        status: 'idle',
      };

      await channelService.upsert(newChannel);

      // Initial update in background
      updateChannel(newChannel, 5).then(() => reloadData());

      addModalOpenRequest.value = null;
      await reloadData();
    } catch (err: unknown) {
      await dialog.alert('添加失败：' + errorMessage(err));
    } finally {
      isSubmittingAdd.value = false;
    }
  }

  // ---- Delete creator / channel (cascade) ----
  //
  // Q5 (DELETION_MODEL §6): the suppression survives the unfollow silently, so
  // a user who deleted posts here has no way to know they stay deleted after
  // re-following. The confirmation names the count when there is one, and says
  // nothing extra when there is not (an always-on notice for N = 0 is noise).
  async function deleteCreator(creatorId: string) {
    const suppressed = await postService.suppressionsUnderCreator(creatorId);
    const note = suppressed > 0
      ? `\n\n该创作者下你删过的 ${suppressed} 条动态仍保持删除状态，重新关注后也不会再出现。`
      : '';
    if (!(await dialog.confirm(`确定要删除此博主档案吗？相关的渠道与历史动态也将一并移除。${note}`))) return;
    await creatorService.deleteCascade(creatorId);
    await reloadData();
  }

  async function deleteCreatorsBatch(creatorIds: string[]) {
    if (creatorIds.length === 0) return;
    let suppressed = 0;
    for (const id of creatorIds) suppressed += await postService.suppressionsUnderCreator(id);
    const note = suppressed > 0
      ? `\n\n这些创作者下你删过的 ${suppressed} 条动态仍保持删除状态，重新关注后也不会再出现。`
      : '';
    if (!(await dialog.confirm(`确定要批量移除选中的 ${creatorIds.length} 位创作者档案及其全部绑定账号与已缓存作品吗？${note}`))) {
      return;
    }
    for (const id of creatorIds) {
      await creatorService.deleteCascade(id);
    }
    await reloadData();
    await dialog.alert('批量删除完成。');
  }

  async function deleteChannel(channelId: string) {
    const suppressed = await postService.suppressionsUnderChannels([channelId]);
    const note = suppressed > 0
      ? `\n\n该账号下你删过的 ${suppressed} 条动态仍保持删除状态，重新绑定后也不会再出现。`
      : '';
    if (!(await dialog.confirm(`确定移除此平台账号吗？${note}`))) return;
    await channelService.deleteCascade(channelId);
    await reloadData();
  }

  // ---- Quick creator tags editor (modal owns the draft; manager owns persistence) ----
  const editingTagCreator = ref<Creator | null>(null);

  function openEditCreatorTags(creator: Creator) {
    editingTagCreator.value = creator;
  }

  async function saveCreatorTags(newTags: string[]) {
    const c = editingTagCreator.value;
    if (!c) return;

    c.tags = newTags;
    c.updatedAt = Date.now();

    try {
      await creatorService.updateTags(c.id, newTags);
      await reloadData();
      editingTagCreator.value = null;
    } catch (err: unknown) {
      await dialog.alert('修改标签失败：' + errorMessage(err));
    }
  }

  // ---- Global tag management: Delete a tag from all creators in the library ----
  async function deleteGlobalTag(tagToDelete: string) {
    if (!(await dialog.confirm(`确定要从系统全库中移除标签【#${tagToDelete}】吗？\n所有包含该标签的创作者都将自动取消此标签关联。`))) {
      return;
    }
    try {
      await creatorService.removeGlobalTag(tagToDelete);
      // Remove from active filters if selected
      clearTagFromFilters(tagToDelete);
      await reloadData();
    } catch (err: unknown) {
      await dialog.alert('移除标签失败：' + errorMessage(err));
    }
  }

  // ---- Inject sample demo data for quick test ----
  async function loadDemoData() {
    const demoCreator: Creator = {
      id: 'demo_alice',
      name: '爱丽丝（演示博主）',
      avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Alice',
      tags: ['ASMR', '插画', '多账号示范'],
      note: '跨平台与同平台多账号归集样例',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const demoChannel1: Channel = {
      id: 'bilibili:1000000000',
      creatorId: 'demo_alice',
      platform: 'bilibili',
      accountId: '1000000000',
      displayName: '演示平台账号',
      profileUrl: 'https://space.bilibili.com/1000000000',
      label: '主账号',
      accountRole: 'main',
      status: 'idle',
    };

    const demoChannel2: Channel = {
      id: 'bilibili:1000000001',
      creatorId: 'demo_alice',
      platform: 'bilibili',
      accountId: '1000000001',
      displayName: '演示备用账号',
      profileUrl: 'https://space.bilibili.com/1000000001',
      label: '日常小号',
      accountRole: 'sub',
      status: 'idle',
    };

    const demoChannel3: Channel = {
      id: 'youtube:UC_DEMO_CREATOR_000000000000000',
      creatorId: 'demo_alice',
      platform: 'youtube',
      accountId: 'UC_DEMO_CREATOR_000000000000000',
      displayName: '演示视频频道',
      profileUrl: 'https://www.youtube.com/channel/UC_DEMO_CREATOR_000000000000000',
      label: '海外主频道',
      accountRole: 'main',
      status: 'idle',
    };

    await creatorService.save(demoCreator);
    await channelService.upsert(demoChannel1);
    await channelService.upsert(demoChannel2);
    await channelService.upsert(demoChannel3);

    await reloadData();
  }

  /** Persist a manual creator order (drag & drop in "手动排序" mode). */
  async function reorderCreators(orderedIds: string[]) {
    await creatorService.updateSortOrder(orderedIds);
    await reloadData();
  }

  return {
    addModalOpenRequest,
    isSubmittingAdd,
    openAddModal,
    failedAvatarUrls,
    avatarPickerCreator,
    editingTagCreator,
    handleAvatarError,
    getCreatorAvatar,
    openAvatarPicker,
    selectPrimaryAvatar,
    openEditCreatorTags,
    saveCreatorTags,
    deleteGlobalTag,
    submitAdd,
    deleteCreator,
    deleteCreatorsBatch,
    deleteChannel,
    cycleChannelRole,
    reorderCreators,
    loadDemoData,
  };
}
