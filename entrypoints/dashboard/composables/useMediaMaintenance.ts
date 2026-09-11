import { ref } from 'vue';
import { healBrokenPostMedia, cleanupOldPosts } from '../../../src/infrastructure/db/postRepository';
import { errorMessage } from '../../../src/utils/errorMessage';

export interface MediaMaintenanceDependencies {
  reloadData: () => Promise<void>;
}

/**
 * Dashboard Settings "data maintenance" actions: XHS broken-media healing and
 * old unbookmarked-post cleanup. Both live behind the Settings view context;
 * delegates to the postRepository helpers (via direct repository import, the
 * same seam the existing `useDashboardData` uses for healing during reload).
 */
export function useMediaMaintenance(deps: MediaMaintenanceDependencies) {
  const isHealingMedia = ref(false);
  const isCleaningStorage = ref(false);

  async function handleHealBrokenMedia() {
    if (isHealingMedia.value) return;
    isHealingMedia.value = true;
    try {
      const healed = await healBrokenPostMedia();
      await deps.reloadData();
      if (healed > 0) {
        alert(`【小红书图裂修复完成】成功修复并重写了本地数据库中 ${healed} 条动态的媒体链接！`);
      } else {
        alert(`【检测完成】本地所有小红书动态与图片的 CDN 地址均已为最新兼容格式。`);
      }
    } catch (err: unknown) {
      const message = errorMessage(err);
      alert('修复异常：' + message);
    } finally {
      isHealingMedia.value = false;
    }
  }

  async function handleCleanupPosts(days: number) {
    const daysText = days === 0 ? '所有未收藏的动态' : `${days} 天前的未收藏历史动态`;
    if (!confirm(`确定要清理 ${daysText} 吗？\n\n提示：带有 ⭐ 收藏标记的动态将被永久保留，绝不会被删除。`)) {
      return;
    }

    isCleaningStorage.value = true;
    try {
      const deletedCount = await cleanupOldPosts(days);
      await deps.reloadData();
      alert(`【存储空间已释放】成功清理了 ${deletedCount} 条历史动态！`);
    } catch (err: unknown) {
      const message = errorMessage(err);
      alert('清理失败：' + message);
    } finally {
      isCleaningStorage.value = false;
    }
  }

  return { isHealingMedia, isCleaningStorage, handleHealBrokenMedia, handleCleanupPosts };
}
