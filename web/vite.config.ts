import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3100',
      '/ws': { target: 'ws://127.0.0.1:3100', ws: true },
      '/health': 'http://127.0.0.1:3100',
    },
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
