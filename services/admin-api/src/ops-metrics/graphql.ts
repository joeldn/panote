import { OpsUnavailable } from './unavailable.js';

// Cloudflare's GraphQL Analytics API, with the same Account Analytics: Read token the
// tour insights use (CF_ANALYTICS_TOKEN). Values go into the query text as literals rather
// than variables: the datasets disagree on whether a time is a `string` or a `Time`, and
// every value interpolated here is either an ISO time we made or a name OpsResourcesSchema
// checked.

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
export const GRAPHQL_TIMEOUT_MS = 10_000;

export type GqlRow = Record<string, unknown>;

/** A string literal in a query: a JSON string is a valid GraphQL one. */
export const lit = (s: string): string => JSON.stringify(s);

/** `datetime_geq`/`datetime_leq` for a window, as GraphQL filter fields. */
export const between = (from: Date, to: Date): string =>
  `datetime_geq: ${lit(from.toISOString())}, datetime_leq: ${lit(to.toISOString())}`;

/**
 * Runs `body` (the aliased dataset selections) for this account, and returns each alias's
 * rows. Any GraphQL error, HTTP failure or odd shape is OpsUnavailable with a short reason:
 * the section it belongs to shows that reason, and the rest of the page carries on.
 */
export const queryAccount = async (
  env: Pick<Env, 'CF_ACCOUNT_ID' | 'CF_ANALYTICS_TOKEN'>,
  body: string,
): Promise<Record<string, GqlRow[]>> => {
  const query = `{ viewer { accounts(filter: { accountTag: ${lit(env.CF_ACCOUNT_ID)} }) { ${body} } } }`;
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new OpsUnavailable(`GraphQL fetch failed: ${err instanceof Error ? err.name : 'error'}`);
  });
  if (!res.ok) throw new OpsUnavailable(`GraphQL API ${res.status}`);
  const json = (await res.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: Record<string, unknown>[] } } | null;
    errors?: { message?: unknown }[] | null;
  } | null;
  const first = json?.errors?.[0];
  if (first) {
    const message = typeof first.message === 'string' ? first.message : 'unknown error';
    throw new OpsUnavailable(`GraphQL: ${message.slice(0, 200)}`);
  }
  const account = json?.data?.viewer?.accounts?.[0];
  if (!account) throw new OpsUnavailable('GraphQL: no account in the answer');
  const out: Record<string, GqlRow[]> = {};
  for (const [alias, rows] of Object.entries(account)) {
    if (!Array.isArray(rows)) throw new OpsUnavailable(`GraphQL: ${alias} is not a list`);
    out[alias] = rows as GqlRow[];
  }
  return out;
};

/** A number at `path` in a row (`sum.requests`); 0 when absent or null. */
export const at = (row: GqlRow, path: string): number => {
  let v: unknown = row;
  for (const part of path.split('.')) {
    v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
  }
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new OpsUnavailable(`GraphQL: ${path} is not a number`);
  return n;
};

/** A dimension's string value; '' when absent. */
export const dim = (row: GqlRow, name: string): string => {
  const d = row.dimensions;
  const v = d && typeof d === 'object' ? (d as Record<string, unknown>)[name] : undefined;
  return typeof v === 'string' ? v : '';
};

/** Whether the row has a non-null value at `path`. */
export const has = (row: GqlRow, path: string): boolean => {
  let v: unknown = row;
  for (const part of path.split('.')) {
    v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
  }
  return v !== undefined && v !== null;
};
