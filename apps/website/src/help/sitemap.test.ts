// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { SITEMAP_PATHS } from '../../vite.config.js';
import { HELP_PAGES } from './pages.js';

describe('sitemap', () => {
  it('lists every help page for crawlers', () => {
    for (const { path } of HELP_PAGES) expect(SITEMAP_PATHS).toContain(path);
  });
});
