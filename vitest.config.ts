import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // The popup template references `/icons/icon-48.png` by public URL, which
      // the Vue plugin turns into an import; SSR has no public dir, so resolve it
      // to the real file.
      '/icons': path.resolve(import.meta.dirname, 'public/icons'),
    },
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      // Scoped to the three modules whose bugs silently corrupt user data
      // (audit P2-14): the deletion lifecycle, the sync loop, and backup
      // import/export. A global percentage was explicitly rejected — it rewards
      // testing whatever is easiest to reach, which here is UI code that a
      // thrown error would make obvious anyway.
      include: [
        'src/sync/channelSync.ts',
        'src/infrastructure/db/postRepository.ts',
        'src/infrastructure/db/backupRepository.ts',
      ],
      // RATCHET, not an aspiration: the numbers below are what the suite
      // actually measured when this was added (2026-09-12), rounded down. The
      // point is that they can only go up — a PR that deletes coverage in these
      // files fails, and one that adds it must raise the floor here.
      thresholds: {
        'src/sync/channelSync.ts': { branches: 78 },
        // 26% before this change: the whole non-deletion half of the file
        // (flags / cleanup / media healing) had no test at all, which only
        // became visible once coverage was scoped to specific files rather than
        // measured globally.
        'src/infrastructure/db/postRepository.ts': { branches: 75 },
        'src/infrastructure/db/backupRepository.ts': { branches: 85 },
      },
    },
  },
});
