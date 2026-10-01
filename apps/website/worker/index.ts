import { resolveSlugRedirect } from './redirect.js';

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
        return new Response(null, {
          status: 308,
          headers: { Location: location, 'Cache-Control': 'no-store' },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
