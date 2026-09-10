import {
  deleteCreatorCascade,
  putCreator,
  removeGlobalTag,
  updateCreatorRecord,
  updateCreatorsSortOrder,
  updateCreatorTagsRecord,
} from '../infrastructure/db/creatorRepository';
import type { Creator } from '../types';

/**
 * Creator entity lifecycle service — the only application entry point the UI
 * should call for creator CRUD. All persistence lives in the repository
 * layer; nothing here touches Dexie directly.
 */
export const creatorService = {
  /** Upsert / create a creator record (idempotent by id). */
  async save(creator: Creator): Promise<void> {
    await putCreator(creator);
  },

  /** Partial update (avatar write-back, name edits, ...). */
  async update(id: string, changes: Partial<Creator>): Promise<void> {
    await updateCreatorRecord(id, changes);
  },

  /** Replace the tag list and refresh `updatedAt`. */
  async updateTags(id: string, tags: string[]): Promise<void> {
    await updateCreatorTagsRecord(id, tags);
  },

  /**
   * Remove one tag from every creator carrying it (library-wide tag sweep).
   * Returns the number of creators updated.
   */
  async removeGlobalTag(tagToRemove: string): Promise<number> {
    return removeGlobalTag(tagToRemove);
  },

  /** Persist a manual creator order (writes sortOrder indices in one tx). */
  async updateSortOrder(orderedIds: string[]): Promise<void> {
    await updateCreatorsSortOrder(orderedIds);
  },

  /** Delete a creator and all bound channels + cached posts (single tx). */
  async deleteCascade(id: string): Promise<void> {
    await deleteCreatorCascade(id);
  },
};
