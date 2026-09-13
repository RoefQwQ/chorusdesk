import { ref } from 'vue';
import { cleanupOldPosts } from '../../../src/infrastructure/db/postRepository';
import { errorMessage } from '../../../src/utils/errorMessage';
import { dialog } from './useDialog';

export interface MediaMaintenanceDependencies {
  reloadData: () => Promise<void>;
}

/**
 * Dashboard Settings "data maintenance": remove old unbookmarked posts.
 *
 * **The 「一键修复小红书图裂」 action is gone** (user decision, 2026-09-14). It
 * called `postRepository.healBrokenPostMedia`, which walked EVERY post with
 * `db.posts.toArray()` and rewrote the media URLs it could normalize — but the
 * only thing it did was re-run `toSecureMediaUrl`, and every render path already
 * calls that on read. So it was a full-table scan, on the user's request, to
 * write back values the readers derive anyway.
 *
 * Nothing needs it for correctness: a stored row with an un-normalized URL
 * renders correctly regardless, because normalization happens at read time. The
 * action, the repository helper, and the reload-time `runMediaHealingOnce` pass
 * that existed to bound its cost are all removed together — leaving any one of
 * them behind would be dead code with no caller.
 */
export function useMediaMaintenance(deps: MediaMaintenanceDependencies) {
  const isCleaningStorage = ref(false);

  async function handleCleanupPosts(days: number) {
    const daysText = days === 0 ? '所有未收藏的动态' : `${days} 天前的未收藏历史动态`;
    if (!(await dialog.confirm(`确定要清理 ${daysText} 吗？\n\n提示：带有 ⭐ 收藏标记的动态将被永久保留，绝不会被删除。`))) {
      return;
    }

    isCleaningStorage.value = true;
    try {
      const deletedCount = await cleanupOldPosts(days);
      await deps.reloadData();
      await dialog.alert(`【存储空间已释放】成功清理了 ${deletedCount} 条历史动态！`);
    } catch (err: unknown) {
      const message = errorMessage(err);
      await dialog.alert('清理失败：' + message);
    } finally {
      isCleaningStorage.value = false;
    }
  }

  return { isCleaningStorage, handleCleanupPosts };
}
