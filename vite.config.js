import { defineConfig } from 'vite';

// The whole app is index.html + app.js. Nothing else is needed to build.
export default defineConfig({
  publicDir: false,
  build: { chunkSizeWarningLimit: 1200 },
});
