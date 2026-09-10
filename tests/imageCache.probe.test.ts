import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post } from '../src/types';
import { CACHED_IMAGE_EXTENSIONS, resolveFileExtension } from '../src/services/imageCache/pathResolver';

/**
 * Regression test for the incremental-archive disk probe
 * (`imageCacheService.isPostFullyCached`).
 *
 * The post directory is `[creatorName, platformName, date_postId]`, so the
 * probe MUST resolve the same first segment the writer used. It originally
 * omitted `creatorName`, which made every probe resolve `默认创作者/…`, miss
 * every file written under the real name, and re-download the whole library
 * while reporting「已缓存跳过 0 条」— a silent failure with no error anywhere.
 *
 * The fake file system below models on-disk state by joined path; a probe that
 * resolves a different folder simply finds nothing, which is exactly the bug.
 */

const fs = vi.hoisted(() => ({
  /** path -> byte size */
  disk: new Map<string, number>(),
  /** directories that exist */
  dirs: new Set<string>(),
  /** segments of the most recent directory lookup, for identity assertions */
  lastProbeSegments: null as string[] | null,
}));

vi.mock('../src/services/imageCache/fsManager', () => ({
  getSavedRootDirectoryHandle: async () => ({ name: 'ChorusCache' }),
  clearRootDirectoryHandle: async () => {},
  promptSelectDirectory: async () => null,
  verifyDirectoryPermission: async () => true,
  getOrCreateNestedDirectory: async (_root: unknown, segments: string[]) => ({ segments }),
  getExistingNestedDirectory: async (_root: unknown, segments: string[]) => {
    fs.lastProbeSegments = segments;
    return fs.dirs.has([...segments].join('/')) ? { segments } : null;
  },
  saveBlobToFile: async () => {},
  readFileAsBlob: async (dir: { segments: string[] }, fileName: string) => {
    const size = fs.disk.get([...dir.segments, fileName].join('/'));
    return size === undefined ? null : ({ size } as Blob);
  },
}));

import { imageCacheService } from '../src/services/imageCache';

const CREATOR = '爱丽丝';
const WRITER_SEGMENTS = [CREATOR, '哔哩哔哩', '20240426_1234567890'];

/** Register a file that exists on the fake disk (creating its folder). */
function writeFile(segments: string[], fileName: string, size = 1024) {
  fs.dirs.add(segments.join('/'));
  fs.disk.set([...segments, fileName].join('/'), size);
}

function makePost(mediaCount: number): Post {
  return {
    id: 'bilibili_1234567890',
    creatorId: 'creator_alice',
    channelId: 'bilibili:1000',
    platform: 'bilibili',
    content: 'probe fixture',
    mediaList: Array.from({ length: mediaCount }, (_, i) => ({
      type: 'image' as const,
      previewUrl: `https://i0.hdslb.com/bfs/album/${i}.jpg`,
      originalUrl: `https://i0.hdslb.com/bfs/album/${i}.jpg`,
    })),
    originalUrl: 'https://t.bilibili.com/1234567890',
    publishedAt: 1_714_100_000_000,
    fetchedAt: 1_714_100_000_000,
    isRead: 0,
  };
}

beforeEach(() => {
  fs.disk.clear();
  fs.dirs.clear();
  fs.lastProbeSegments = null;
});

describe('isPostFullyCached', () => {
  it('finds media written under the creator name it is given', async () => {
    writeFile(WRITER_SEGMENTS, '0.jpg');

    await expect(imageCacheService.isPostFullyCached(makePost(1), CREATOR)).resolves.toBe(true);
    // Pins the directory identity, not just the boolean: omitting creatorName
    // resolves to the placeholder folder and can never hit the file above.
    expect(fs.lastProbeSegments).toEqual(WRITER_SEGMENTS);
  });

  it('does not report a hit when the files live under another creator folder', async () => {
    writeFile(['默认创作者', '哔哩哔哩', '20240426_1234567890'], '0.jpg');

    await expect(imageCacheService.isPostFullyCached(makePost(1), CREATOR)).resolves.toBe(false);
  });

  it('does not report a hit for a post missing any media item', async () => {
    writeFile(WRITER_SEGMENTS, '0.jpg');

    await expect(imageCacheService.isPostFullyCached(makePost(2), CREATOR)).resolves.toBe(false);
  });

  it('accepts every extension the writer can produce', async () => {
    for (const ext of CACHED_IMAGE_EXTENSIONS) {
      fs.disk.clear();
      fs.dirs.clear();
      writeFile(WRITER_SEGMENTS, `0.${ext}`);

      await expect(imageCacheService.isPostFullyCached(makePost(1), CREATOR)).resolves.toBe(true);
    }
  });

  it('reports not-cached when the post folder does not exist yet', async () => {
    await expect(imageCacheService.isPostFullyCached(makePost(1), CREATOR)).resolves.toBe(false);
  });
});

describe('cached media extensions', () => {
  it('covers every extension resolveFileExtension can return', () => {
    const samples: Array<[string, string | undefined]> = [
      ['https://i0.hdslb.com/a.jpg', undefined],
      ['https://i0.hdslb.com/a.jpeg', undefined],
      ['https://i0.hdslb.com/a.png', undefined],
      ['https://i0.hdslb.com/a.webp', undefined],
      ['https://i0.hdslb.com/a.gif', undefined],
      ['https://i0.hdslb.com/a.avif', undefined],
      ['https://i0.hdslb.com/a', 'image/jpeg'],
      ['https://i0.hdslb.com/a', 'image/png'],
      ['https://i0.hdslb.com/a', 'image/webp'],
      ['https://i0.hdslb.com/a', 'image/gif'],
      ['https://i0.hdslb.com/a', 'image/avif'],
      ['https://i0.hdslb.com/a', 'application/octet-stream'],
      ['', undefined],
    ];

    for (const [url, mime] of samples) {
      expect(CACHED_IMAGE_EXTENSIONS).toContain(resolveFileExtension(url, mime));
    }
  });
});
