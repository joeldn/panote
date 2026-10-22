import { escapeAttr } from './og.js';

// /explore's own title and link preview text, in place of the landing page's.
// The SPA sets the same title once it runs (src/explore/Explore.tsx, EXPLORE_TITLE).
export const EXPLORE_META = {
  title: 'Explore 360° tours · panote',
  description:
    'Public 360° tours on panote, newest first. Walk through each one at full resolution.',
} as const;

export const EXPLORE_PATH = '/explore';

/**
 * index.html with /explore's title, description and og:title/og:description, and an
 * og:url for the page. The site-wide preview image stays: the page has none of its own.
 */
export function explorePage(response: Response, origin: string): Response {
  const content = (value: string) => ({
    element(el: Element) {
      el.setAttribute('content', value);
    },
  });
  const rewritten = new HTMLRewriter()
    .on('head > title', {
      element(el) {
        el.setInnerContent(EXPLORE_META.title);
      },
    })
    .on('head > meta[name="description"]', content(EXPLORE_META.description))
    .on('head > meta[property="og:title"]', content(EXPLORE_META.title))
    .on('head > meta[property="og:description"]', content(EXPLORE_META.description))
    .on('head', {
      element(el) {
        el.append(`<meta property="og:url" content="${escapeAttr(`${origin}${EXPLORE_PATH}`)}">`, {
          html: true,
        });
      },
    })
    .transform(response);
  const page = new Response(rewritten.body, rewritten);
  // The body no longer matches the asset's validator.
  page.headers.delete('ETag');
  return page;
}
