import { copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildHeadersFile, loadConfig } from '@internal/web-kit/build';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const MODES = ['dev', 'production'];
const API_TARGET = 'https://panote.dev';
const ASSETS_DIR = resolve(import.meta.dirname, 'dist');

// Assets build into dist/app/ to match the /app/ base, but the Worker's assets root is
// dist/: _headers must live there, and SPA fallback always serves dist/index.html.
function workerAssets(mode: string): Plugin {
  return {
    name: 'panote:worker-assets',
    apply: 'build',
    async writeBundle() {
      const env = loadEnv(mode, import.meta.dirname, '');
      const config = loadConfig(env);
      const connectSrc = env.CSP_UPLOAD_ORIGIN ? [env.CSP_UPLOAD_ORIGIN] : [];
      await writeFile(
        resolve(ASSETS_DIR, '_headers'),
        // frame-src 'self': the share modal previews the site's /s/<slug>/embed (same origin).
        buildHeadersFile(config, { connectSrc, frameSrc: ["'self'"], noindex: mode === 'dev' }),
      );
      await copyFile(resolve(ASSETS_DIR, 'app/index.html'), resolve(ASSETS_DIR, 'index.html'));
    },
  };
}

export default defineConfig(({ mode }) => {
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}", expected ${MODES.join('|')}`);
  return {
    base: '/app/',
    plugins: [react(), workerAssets(mode)],
    // No data: URIs: the CSP's font-src is 'self' only.
    build: { outDir: 'dist/app', emptyOutDir: true, assetsInlineLimit: 0 },
    // The APIs stay same-origin in local dev. Port 5173 is the Auth0 dev callback origin.
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
    },
    preview: {
      port: 4173,
      strictPort: true,
      proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
    },
  };
});
