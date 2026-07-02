import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/Skyline-Rush/' : '/',
  server: {
    port: 8080,
  },
  build: {
    outDir: 'dist',
    // Keep building GLBs as separate cacheable assets — after slimming many
    // fall below the inline threshold and would otherwise bloat the JS bundle.
    assetsInlineLimit: (file) => (file.endsWith('.glb') ? false : undefined),
  },
});
