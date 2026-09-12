import { computed, ref } from 'vue';
import type { Channel, Post, RecycleSnapshot } from '../../../src/types';
import { postService } from '../../../src/application';
import type { updateChannel as UpdateChannelFn } from '../../../src/sync/channelSync';
import { notifyBadgeRefresh } from '../../../src/utils/badge';
import { dialog } from './useDialog';

export interface RecycleBinActions {
  reloadData: () => Promise<void>;
  refreshAll: (restoreDeleted?: boolean) => Promise<void>;
  removePostFromFeed: (postId: string) => void;
  getChannels: () => Channel[];
  channelUpdate: typeof UpdateChannelFn;
  itemsPerFetch: () => number;
}

/**
 * Deleted-posts (tombstone recycle bin) state, filters and actions for the
 * Dashboard sync/settings surface. Pure composition over the existing db
 * helpers — no behavior change, only relocation of responsibility.
 */
export function useDeletedPosts(actions: RecycleBinActions) {
  const deletedPostCount = ref(0);
  const deletedPostsList = ref<RecycleSnapshot[]>([]);
  const showDeletedPostsModal = ref(false);
  const deletedPostsSearchQuery = ref('');
  const showSyncMenu = ref(false);

  const filteredDeletedPostsList = computed(() => {
    const q = deletedPostsSearchQuery.value.trim().toLowerCase();
    if (!q) return deletedPostsList.value;
    return deletedPostsList.value.filter(item => {
      return (
        (item.title && item.title.toLowerCase().includes(q)) ||
        (item.id && item.id.toLowerCase().includes(q)) ||
        (item.platform && item.platform.toLowerCase().includes(q))
      );
    });
  });

  async function refreshDeletedCount() {
    try {
      deletedPostCount.value = await postService.recycleBinCount();
    } catch {
      deletedPostCount.value = 0;
    }
  }

  /** Reload both the tombstone records list and the total count. */
  async function refreshDeletedPostsList() {
    deletedPostsList.value = await postService.recycleBinRecords();
    await refreshDeletedCount();
  }

  async function handleDeletePost(post: Post) {
    const snippet = post.title || (post.content ? post.content.slice(0, 35) : '该动态');
    if (!(await dialog.confirm(`确定要删除此条动态吗？\n\n“${snippet}”\n\n提示：该动态ID将记录到本地数据库黑名单中。后续点击“同步全部”默认不会重新拉取此动态；可在设置或同步选项中随时查看与恢复。`))) {
      return;
    }
    await postService.deleteToRecycleBin(post);
    actions.removePostFromFeed(post.id);
    await refreshDeletedCount();
    // Deleting a post can remove it from the unread set the badge shows.
    notifyBadgeRefresh();
  }

  async function openDeletedPostsModal() {
    deletedPostsList.value = await postService.recycleBinRecords();
    await refreshDeletedCount();
    deletedPostsSearchQuery.value = '';
    showDeletedPostsModal.value = true;
  }

  async function handleRestoreSingleDeleted(record: RecycleSnapshot) {
    const restoredPost = await postService.restoreFromRecycleBin(record.id);
    deletedPostsList.value = deletedPostsList.value.filter(r => r.id !== record.id);
    await actions.reloadData();
    await refreshDeletedCount();
    if (restoredPost) {
      await dialog.alert(`【动态已定向找回】\n已将动态“${restoredPost.title || '该作品'}”直接还原到动态列表中！`);
    } else {
      // No snapshot to write back: either the channel is gone (the orphan was
      // dropped, I11) or the snapshot predates the record. A re-fetch is the
      // only path left, and it clears the suppression for what it returns.
      const ch = actions.getChannels().find(c => c.id === record.channelId);
      if (ch) {
        await actions.channelUpdate(ch, actions.itemsPerFetch(), true, { restoreDeleted: true });
        await actions.reloadData();
      }
      await dialog.alert(`【动态已定向找回】已解除过滤并重新拉取该动态！`);
    }
  }

  async function handleRestoreAllAndSync() {
    if (deletedPostCount.value === 0) return;
    if (!(await dialog.confirm(`确定要将回收站中全部 ${deletedPostCount.value} 条已删除动态定向找回并还原到动态列表中吗？`))) return;
    await postService.restoreAllFromRecycleBin();
    await actions.reloadData();
    await refreshDeletedCount();
    deletedPostsList.value = [];
    showDeletedPostsModal.value = false;
    await actions.refreshAll(true);
    await dialog.alert(`【全部找回完成】回收站动态已全部恢复并还原至动态流！`);
  }

  async function handlePermanentlyDelete(record: RecycleSnapshot) {
    if (!(await dialog.confirm(`确定要从回收站彻底删除该记录吗？\n\n只会删除这里的快照，动态仍保持「已删除」状态，今后同步也不会再出现。`))) return;
    await postService.permanentlyDelete(record.id);
    deletedPostsList.value = deletedPostsList.value.filter(r => r.id !== record.id);
    await refreshDeletedCount();
  }

  async function handleEmptyRecycleBin() {
    if (deletedPostCount.value === 0) return;
    if (!(await dialog.confirm(`确定要彻底清空回收站中全部 ${deletedPostCount.value} 条记录吗？\n\n只会删除快照，这些动态仍保持「已删除」状态，今后同步也不会再出现。`))) return;
    await postService.emptyRecycleBin();
    deletedPostsList.value = [];
    await refreshDeletedCount();
    await dialog.alert('回收站已彻底清空。');
  }

  return {
    deletedPostCount,
    deletedPostsList,
    showDeletedPostsModal,
    deletedPostsSearchQuery,
    showSyncMenu,
    filteredDeletedPostsList,
    refreshDeletedCount,
    refreshDeletedPostsList,
    handleDeletePost,
    openDeletedPostsModal,
    handleRestoreSingleDeleted,
    handleRestoreAllAndSync,
    handlePermanentlyDelete,
    handleEmptyRecycleBin,
  };
}
