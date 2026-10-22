// Argument handling and the R2/Queues steps for the operator's bulk re-tile CLI
// (retile.ts). Pure apart from the store and fetch, so the Worker test pool covers it.
import { PANO_PATTERN } from '@internal/contracts';
import type { R2ListedObject, R2S3Client } from '@internal/worker-kit/r2-s3';

import { r2ConfigFromEnv, type R2Config } from './delete-account-lib.ts';
import type { FetchLike } from './takedown-lib.ts';

export interface RetileArgs {
  /** null: every pano with an original. */
  panos: string[] | null;
  /** False unless --apply: report what would be queued and send nothing. */
  apply: boolean;
  r2: R2Config;
  queue: string;
  /** Only with --apply: a Cloudflare API token that can write to Queues. */
  apiToken: string | undefined;
}

export const USAGE =
  'usage: retile.ts (--pano <panoId>... | --all) [--apply] [--allow-bucket <bucket>]\n' +
  '       Without --apply it only lists what it would queue.';

// The queue each bucket's R2 notification feeds (docs/deploy.md, "R2 -> queue notification").
const QUEUES: Record<string, string> = {
  'pano-content-dev': 'pano-uploads-dev',
  'pano-content': 'pano-uploads',
};

export function parseRetileArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): RetileArgs {
  const panos: string[] = [];
  let all = false;
  let apply = false;
  let allowBucket: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--all') {
      all = true;
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--pano' || arg === '--allow-bucket') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--allow-bucket') allowBucket = value;
      else if (!PANO_PATTERN.test(value)) throw new Error(`--pano must match ${PANO_PATTERN}`);
      else panos.push(value);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  // Every pano is a lot of container time: it has to be asked for by name.
  if (all === panos.length > 0) throw new Error('name panos with --pano, or pass --all');

  const r2 = r2ConfigFromEnv(env, allowBucket);
  const queue = QUEUES[r2.bucket];
  if (!queue) throw new Error(`no upload queue known for ${r2.bucket}`);
  const apiToken = env.CF_QUEUES_TOKEN;
  if (apply && !apiToken) throw new Error('missing env CF_QUEUES_TOKEN (needed with --apply)');
  return { panos: all ? null : [...new Set(panos)], apply, r2, queue, apiToken };
}

export interface RetileTarget {
  panoId: string;
  /** panos/<owner>/<panoId>/original, owner already encoded. */
  key: string;
  size: number;
}

const ORIGINAL_RE = /^panos\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/original$/;
const DELETING_RE = /^panos\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)\/deleting$/;

/**
 * The originals in a listing of panos/, minus any pano mid-delete (it has a
 * tombstone). `wanted` narrows it to those panoIds; null keeps all.
 */
export function findTargets(
  listed: readonly R2ListedObject[],
  wanted: readonly string[] | null,
): { targets: RetileTarget[]; deleting: string[]; missing: string[] } {
  const deleting = new Set<string>();
  for (const o of listed) {
    const m = DELETING_RE.exec(o.key);
    if (m) deleting.add(m[1]!);
  }
  const want = wanted ? new Set(wanted) : null;
  const targets: RetileTarget[] = [];
  const skipped: string[] = [];
  for (const o of listed) {
    const m = ORIGINAL_RE.exec(o.key);
    if (!m) continue;
    const panoId = m[2]!;
    if (want && !want.has(panoId)) continue;
    if (deleting.has(panoId)) skipped.push(panoId);
    else targets.push({ panoId, key: o.key, size: o.size });
  }
  const found = new Set([...targets.map((t) => t.panoId), ...skipped]);
  const missing = wanted ? wanted.filter((p) => !found.has(p)) : [];
  return { targets, deleting: skipped, missing };
}

/** The original's current ETag (bare), or null when it has gone since the listing. */
export async function currentEtag(
  store: Pick<R2S3Client, 'head'>,
  key: string,
): Promise<string | null> {
  const head = await store.head(key);
  if (head.status === 404) return null;
  if (!head.ok || !head.etag) throw new Error(`R2 HEAD -> ${head.status}`);
  return head.etag.replace(/^"|"$/g, '');
}

/**
 * The message an R2 object-create notification would have put on the queue
 * for this original, so tiler-consumer handles it exactly like a fresh upload:
 * the same size guard, the same key checks, and the same ETag the failure
 * marker and the manifest swap are checked against.
 */
export function notificationFor(
  target: RetileTarget,
  etag: string,
  r2: Pick<R2Config, 'accountId' | 'bucket'>,
  now: Date,
) {
  return {
    account: r2.accountId,
    bucket: r2.bucket,
    action: 'PutObject',
    object: { key: target.key, size: target.size, eTag: etag },
    eventTime: now.toISOString(),
  };
}

const API = 'https://api.cloudflare.com/client/v4';

const apiError = async (res: Response, what: string): Promise<Error> => {
  const json: unknown = await res.json().catch(() => null);
  const errors =
    json && typeof json === 'object' && 'errors' in json ? JSON.stringify(json.errors) : '';
  return new Error(`${what} -> ${res.status} ${errors}`);
};

/** The queue's id, from its name (Queues API: list queues). */
export async function resolveQueueId(
  fetchFn: FetchLike,
  accountId: string,
  token: string,
  name: string,
): Promise<string> {
  const res = await fetchFn(`${API}/accounts/${accountId}/queues`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await apiError(res, 'list queues');
  const json = (await res.json()) as { result?: Array<{ queue_id?: string; queue_name?: string }> };
  const id = json.result?.find((q) => q.queue_name === name)?.queue_id;
  if (!id) throw new Error(`queue ${name} not found in account ${accountId}`);
  return id;
}

// The Queues API takes at most 100 messages per batch.
export const SEND_BATCH = 100;

/** Sends the messages (Queues API: send batch), SEND_BATCH at a time. */
export async function sendToQueue(
  fetchFn: FetchLike,
  accountId: string,
  token: string,
  queueId: string,
  bodies: readonly unknown[],
): Promise<number> {
  let sent = 0;
  for (let i = 0; i < bodies.length; i += SEND_BATCH) {
    const chunk = bodies.slice(i, i + SEND_BATCH);
    const res = await fetchFn(`${API}/accounts/${accountId}/queues/${queueId}/messages/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chunk.map((body) => ({ body, content_type: 'json' })) }),
    });
    if (!res.ok) throw await apiError(res, `send batch after ${sent} sent`);
    sent += chunk.length;
  }
  return sent;
}
