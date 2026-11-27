import { defineConfig } from 'vitest/config';

export default defineConfig({
  // three.js core pesa ~680 kB minificado; los loaders se cargan bajo demanda.
  build: { chunkSizeWarningLimit: 800 },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
