import {
  buildHeadersFile,
  isIndexable,
  loadConfig,
  robotsTxt,
  sitemapXml,
} from '@internal/web-kit/build';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

import { HELP_PAGES } from './src/help/pages.js';

const MODES = ['dev', 'production'];
const API_TARGET = 'https://panote.dev';
// The pages a crawler should find from the sitemap. Tours aren't listed: a public tour is
// found through links to it (Explore links every one), and an unlisted one must not be.
export const SITEMAP_PATHS = [
  '/',
  '/explore',
  ...HELP_PAGES.map((p) => p.path),
  '/privacy',
  '/terms',
  '/content-policy',
];

// Validates the env at build time and emits dist/_headers (CSP, noindex off production),
// dist/robots.txt and dist/sitemap.xml, so both are real files rather than the SPA fallback
// (docs/deploy.md). Off production the sitemap lists nothing and robots.txt doesn't name it.
function workerAssets(mode: string): Plugin {
  return {
    name: 'panote:worker-assets',
    apply: 'build',
    generateBundle() {
      const config = loadConfig(loadEnv(mode, import.meta.dirname, 'VITE_'));
      const indexable = isIndexable(mode);
      const sitemap = `${config.siteOrigin}/sitemap.xml`;
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: buildHeadersFile(config, {
          framable: ['/s/:slug/embed', '/s/:slug/embed/'],
          indexable,
        }),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: robotsTxt(indexable, sitemap),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: sitemapXml(config.siteOrigin, indexable ? SITEMAP_PATHS : []),
      });
    },
  };
}

// index.html's link preview image needs an absolute URL, so `%SITE_ORIGIN%` there becomes
// this mode's validated VITE_SITE_ORIGIN (panote.dev or panote.io, no trailing slash).
function siteOrigin(mode: string): Plugin {
  return {
    name: 'panote:site-origin',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const { siteOrigin } = loadConfig(loadEnv(mode, import.meta.dirname, 'VITE_'));
        return html.replaceAll('%SITE_ORIGIN%', siteOrigin);
      },
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
    plugins: [react(), siteOrigin(mode), cdnPreconnect(mode), workerAssets(mode)],
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
