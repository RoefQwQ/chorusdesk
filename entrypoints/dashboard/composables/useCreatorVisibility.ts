import { ref } from 'vue';
import type { Channel } from '../../../src/types';

const HIDDEN_CREATORS_KEY = 'creator_feed_hidden_creators';
const HIDDEN_PLATFORMS_KEY = 'creator_feed_hidden_platforms';

export interface CreatorVisibilityActions {
  /** 返回全部平台账号（用于推导某创作者已绑定的平台）。 */
  getChannels: () => Channel[];
}

/**
 * Hidden creators & per-creator hidden platform sub-filters for the Feed
 * sidebar/directory. Pure UI preference state persisted to localStorage
 * (`creator_feed_` prefix); no database or sync involvement.
 */
export function useCreatorVisibility(actions: CreatorVisibilityActions) {
  const hiddenCreatorIds = ref<Set<string>>(new Set());
  const hiddenCreatorPlatforms = ref<Record<string, string[]>>({});

  try {
    const savedHidden = localStorage.getItem(HIDDEN_CREATORS_KEY);
    if (savedHidden) {
      hiddenCreatorIds.value = new Set(JSON.parse(savedHidden));
    }
    const savedPlatforms = localStorage.getItem(HIDDEN_PLATFORMS_KEY);
    if (savedPlatforms) {
      hiddenCreatorPlatforms.value = JSON.parse(savedPlatforms);
    }
  } catch {
    // Corrupt or unavailable localStorage: start with nothing hidden.
  }

  function toggleHideCreator(creatorId: string) {
    if (hiddenCreatorIds.value.has(creatorId)) {
      hiddenCreatorIds.value.delete(creatorId);
    } else {
      hiddenCreatorIds.value.add(creatorId);
    }
    hiddenCreatorIds.value = new Set(hiddenCreatorIds.value);
    try {
      localStorage.setItem(HIDDEN_CREATORS_KEY, JSON.stringify(Array.from(hiddenCreatorIds.value)));
    } catch {
      // Storage write blocked: hide state stays in memory for this session.
    }
  }

  function toggleHideCreatorPlatform(creatorId: string, platformKey: string) {
    const current = hiddenCreatorPlatforms.value[creatorId] ? [...hiddenCreatorPlatforms.value[creatorId]] : [];
    const idx = current.indexOf(platformKey);
    if (idx !== -1) {
      current.splice(idx, 1);
    } else {
      current.push(platformKey);
    }
    hiddenCreatorPlatforms.value = {
      ...hiddenCreatorPlatforms.value,
      [creatorId]: current,
    };
    try {
      localStorage.setItem(HIDDEN_PLATFORMS_KEY, JSON.stringify(hiddenCreatorPlatforms.value));
    } catch {
      // Storage write blocked: hide state stays in memory for this session.
    }
  }

  function unhideAllCreators() {
    hiddenCreatorIds.value = new Set();
    try {
      localStorage.removeItem(HIDDEN_CREATORS_KEY);
    } catch {
      // Storage remove blocked: harmless, key is re-created on next write.
    }
  }

  function getCreatorPlatforms(creatorId: string): string[] {
    const chs = actions.getChannels().filter(ch => ch.creatorId === creatorId);
    const platforms = new Set<string>();
    chs.forEach(ch => platforms.add(ch.platform));
    return Array.from(platforms);
  }

  function resetCreatorHiddenPlatforms(creatorId: string) {
    if (hiddenCreatorPlatforms.value[creatorId]) {
      const updated = { ...hiddenCreatorPlatforms.value };
      delete updated[creatorId];
      hiddenCreatorPlatforms.value = updated;
      try {
        localStorage.setItem(HIDDEN_PLATFORMS_KEY, JSON.stringify(hiddenCreatorPlatforms.value));
      } catch {
        // Storage write blocked: hide state stays in memory for this session.
      }
    }
  }

  return {
    hiddenCreatorIds,
    hiddenCreatorPlatforms,
    toggleHideCreator,
    toggleHideCreatorPlatform,
    unhideAllCreators,
    resetCreatorHiddenPlatforms,
    getCreatorPlatforms,
  };
}
