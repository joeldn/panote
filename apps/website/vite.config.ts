import { buildHeadersFile, isIndexable, loadConfig, robotsTxt } from '@internal/web-kit/build';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const MODES = ['dev', 'production'];
const API_TARGET = 'https://panote.dev';

// Validates the env at build time and emits dist/_headers (CSP, noindex off production) and
// dist/robots.txt, so /robots.txt is a real file rather than the SPA fallback (docs/deploy.md).
function workerAssets(mode: string): Plugin {
  return {
    name: 'panote:worker-assets',
    apply: 'build',
    generateBundle() {
      const config = loadConfig(loadEnv(mode, import.meta.dirname, 'VITE_'));
      const indexable = isIndexable(mode);
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: buildHeadersFile(config, {
          framable: ['/s/:slug/embed', '/s/:slug/embed/'],
          indexable,
        }),
      });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt(indexable) });
    },
  };
}

// Opens the CDN connection while the JS downloads instead of after it runs. `crossorigin`
// because the viewer's fetches are CORS. The website Worker reads `data-cdn-base` to build
// the tour page's tile preloads, so the CDN root has one source: VITE_CDN_BASE.
function cdnPreconnect(mode: string): Plugin {
  return {
    name: 'panote:cdn-preconnect',
    transformIndexHtml() {
      const { cdnBase } = loadConfig(loadEnv(mode, import.meta.dirname, 'VITE_'));
      return [
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: new URL(cdnBase).origin,
            crossorigin: true,
            'data-cdn-base': cdnBase,
          },
          injectTo: 'head',
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}", expected ${MODES.join('|')}`);
  return {
    base: '/',
    plugins: [react(), cdnPreconnect(mode), workerAssets(mode)],
    // No data: URIs: the CSP's font-src is 'self' only.
    build: { outDir: 'dist', assetsInlineLimit: 0 },
    // The APIs stay same-origin in local dev; the admin app runs on :5173.
    server: {
      port: 5174,
      strictPort: true,
      proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
    },
    preview: {
      port: 4174,
      strictPort: true,
      proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
    },
  };
});
