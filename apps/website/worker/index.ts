import { resolveSlugRedirect } from './redirect.js';

// Same value as NOINDEX in @internal/web-kit, kept local so the script bundles nothing else.
const NOINDEX = 'noindex, nofollow';

// _headers doesn't cover Worker-generated responses, so off production the script tags them itself.
function withRobots(response: Response, env: Env): Response {
  if (env.INDEXABLE === 'true') return response;
  const tagged = new Response(response.body, response);
  tagged.headers.set('X-Robots-Tag', NOINDEX);
  return tagged;
}

// Runs only for /s/* (assets.run_worker_first); every other path never reaches it.
export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'GET' || request.method === 'HEAD') {
      let location: string | null = null;
      try {
        location = await resolveSlugRedirect(new URL(request.url), env.BUCKET);
      } catch (err) {
        // An R2 hiccup must not take the viewer down: the SPA resolves the slug itself.
        console.error('slug redirect lookup failed', err);
      }
      if (location) {
        const redirect = new Response(null, {
          status: 308,
          headers: { Location: location, 'Cache-Control': 'no-store' },
        });
        return withRobots(redirect, env);
      }
    }
    return withRobots(await env.ASSETS.fetch(request), env);
  },
} satisfies ExportedHandler<Env>;
