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
  },
});
