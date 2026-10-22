// Best-effort Cloudflare cache purge for cdn.<host> (plan 3.5, B6). Paths are R2
// keys, which map 1:1 onto the CDN custom domain's URL paths.
import { CDN_PURGE_FAILURE_KEY, type CdnPurgeFailure } from '@internal/contracts';

export type CdnPurge = { prefixes: string[]; files: string[] };

export const NO_PURGE: CdnPurge = { prefixes: [], files: [] };

export const mergePurges = (...purges: CdnPurge[]): CdnPurge => ({
  prefixes: [...new Set(purges.flatMap((p) => p.prefixes))],
  files: [...new Set(purges.flatMap((p) => p.files))],
});

export type PurgeEnv = {
  CF_PURGE_TOKEN?: string | undefined;
  CDN_ZONE_ID: string;
  CDN_HOST: string;
  // Where a failure is recorded for tiler-consumer's health check (docs/deploy.md,
  // "Monitoring and alerts"). Without it a failure is only logged.
  BUCKET?: R2Bucket;
};

type PurgeOptions = { fetch?: typeof fetch; timeoutMs?: number };

// The API's cap for both prefixes and files per request, on every plan.
export const MAX_PER_REQUEST = 100;
const TIMEOUT_MS = 5_000;
const ZONE_ID_RE = /^[0-9a-f]{32}$/;
const HOST_RE = /^[a-z0-9.-]+$/;

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_PER_REQUEST) {
    out.push(items.slice(i, i + MAX_PER_REQUEST));
  }
  return out;
};

// Only the status and Cloudflare's error codes/messages are logged, never the request.
const describeFailure = async (res: Response): Promise<string> => {
  const body = await res
    .json<{ errors?: { code?: number; message?: string }[] }>()
    .catch(() => null);
  const errors = (body?.errors ?? []).map((e) => `${e.code ?? '?'} ${e.message ?? ''}`.trim());
  return `HTTP ${res.status}${errors.length ? `: ${errors.join('; ')}` : ''}`;
};

// Returns what failed (the same text the log line has), or null when it went through.
const send = async (
  env: PurgeEnv,
  kind: 'prefixes' | 'files',
  values: string[],
  opts: PurgeOptions,
): Promise<string | null> => {
  const doFetch = opts.fetch ?? fetch;
  let reason: string;
  try {
    const res = await doFetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CDN_ZONE_ID}/purge_cache`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CF_PURGE_TOKEN ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ [kind]: values }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      },
    );
    if (res.ok) return null;
    reason = await describeFailure(res);
  } catch (e) {
    reason = e instanceof Error ? e.name : 'unknown error';
  }
  console.error(`cdn purge failed (${kind}, ${values.length}): ${reason}`);
  return `${kind}, ${values.length}: ${reason}`;
};

// Overwrites the one failure marker; nothing reads it back here, so no race to lose.
const recordFailure = async (bucket: R2Bucket, detail: string): Promise<void> => {
  const body: CdnPurgeFailure = { at: new Date().toISOString(), detail };
  try {
    await bucket.put(CDN_PURGE_FAILURE_KEY, JSON.stringify(body), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    console.error(`cdn purge failure not recorded: ${e instanceof Error ? e.name : 'unknown'}`);
  }
};

/** Never throws: a failure is logged and the edge copy expires on its own TTL.
 * No retry on 429 either (the Free plan allows 5 prefix requests/min). */
export const purgeCdn = async (
  env: PurgeEnv,
  purge: CdnPurge,
  opts: PurgeOptions = {},
): Promise<void> => {
  if (purge.prefixes.length === 0 && purge.files.length === 0) return;
  if (!env.CF_PURGE_TOKEN || !ZONE_ID_RE.test(env.CDN_ZONE_ID) || !HOST_RE.test(env.CDN_HOST)) {
    console.warn('cdn purge skipped: CF_PURGE_TOKEN, CDN_ZONE_ID or CDN_HOST not configured');
    return;
  }
  // Prefixes take no scheme; single-file purges take the full URL.
  const prefixes = purge.prefixes.map((p) => `${env.CDN_HOST}/${p}`);
  const files = purge.files.map((f) => `https://${env.CDN_HOST}/${f}`);
  let failed: string | null = null;
  for (const batch of chunks(prefixes))
    failed = (await send(env, 'prefixes', batch, opts)) ?? failed;
  for (const batch of chunks(files)) failed = (await send(env, 'files', batch, opts)) ?? failed;
  if (failed !== null && env.BUCKET) await recordFailure(env.BUCKET, failed);
};
