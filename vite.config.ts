import { defineConfig } from 'vitest/config';

export default defineConfig({
  // En GitHub Pages el sitio vive en /visor-arq-3d/; el workflow define BASE_PATH. En local, '/'.
  base: process.env.BASE_PATH ?? '/',
  // three.js core pesa ~680 kB minificado; los loaders se cargan bajo demanda.
  build: { chunkSizeWarningLimit: 800 },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
