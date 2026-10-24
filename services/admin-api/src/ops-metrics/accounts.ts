import { decodeId, UPLOAD_LOG_ROOT, uploadLogTime, type OpsAccounts } from '@internal/contracts';

import { toPublishSummary } from '../lists.js';

// The accounts section: stocks (accounts, panos, bytes, tours) and who holds the most,
// from listing panos/, tours/ and upload-log/ with their metadata. No object is read.
// Each listing stops at a page budget, so a large bucket gives a floor ("partial") rather
// than a slow page; account-storage.ts (scripts) still lists everything.

/** List pages (1,000 keys each) read per prefix, per uncached dashboard load. */
export const ACCOUNT_SCAN_PAGES = 25;
/** Rows in each account table and in the recently published list. */
export const ACCOUNT_ROWS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

type Listed = Pick<R2Object, 'key' | 'size' | 'uploaded' | 'customMetadata'>;

/** Every object under `prefix`, up to the budget; `partial` when it stopped there. */
const scan = async (
  bucket: R2Bucket,
  prefix: string,
  metadata: boolean,
): Promise<{ objects: Listed[]; partial: boolean }> => {
  const objects: Listed[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ACCOUNT_SCAN_PAGES; page += 1) {
    const listed = await bucket.list({
      prefix,
      ...(metadata ? { include: ['customMetadata' as const] } : {}),
      ...(cursor ? { cursor } : {}),
    });
    objects.push(...listed.objects);
    if (!listed.truncated) return { objects, partial: false };
    cursor = listed.cursor;
  }
  return { objects, partial: true };
};

// <root><owner>/<id>/<name>, the layout of panos/ and tours/.
const OWNED_RE = /^(?:panos|tours)\/([^/]+)\/([^/]+)\/(.+)$/;

interface Account {
  owner: string;
  panos: number;
  originalBytes: number;
  tours: number;
  uploads24h: number;
}

export const accountsSection = async (bucket: R2Bucket, now: Date): Promise<OpsAccounts> => {
  const [panos, tours, uploads] = await Promise.all([
    scan(bucket, 'panos/', false),
    scan(bucket, 'tours/', true),
    scan(bucket, UPLOAD_LOG_ROOT, false),
  ]);
  const byOwner = new Map<string, Account>();
  const of = (owner: string): Account => {
    let a = byOwner.get(owner);
    if (!a) {
      a = { owner, panos: 0, originalBytes: 0, tours: 0, uploads24h: 0 };
      byOwner.set(owner, a);
    }
    return a;
  };

  // The quota's rule (transfer.ts holdings): a pano with a delete tombstone counts for nothing.
  const pano = new Map<string, { owner: string; bytes: number; deleting: boolean }>();
  for (const o of panos.objects) {
    const m = OWNED_RE.exec(o.key);
    if (!m) continue;
    const [, owner, panoId, name] = m as unknown as [string, string, string, string];
    const id = `${owner}/${panoId}`;
    const p = pano.get(id) ?? { owner, bytes: 0, deleting: false };
    if (name === 'original') p.bytes = o.size;
    if (name === 'deleting') p.deleting = true;
    pano.set(id, p);
  }
  for (const p of pano.values()) {
    if (p.deleting) continue;
    const a = of(p.owner);
    a.panos += 1;
    a.originalBytes += p.bytes;
  }

  const titles = new Map<string, string | null>();
  const published: (OpsAccounts['recentlyPublished'][number] & { owner: string })[] = [];
  for (const o of tours.objects) {
    const m = OWNED_RE.exec(o.key);
    if (!m) continue;
    const [, owner, tourId, name] = m as unknown as [string, string, string, string];
    if (name === 'tour.json') {
      of(owner).tours += 1;
      titles.set(tourId, o.customMetadata?.title ?? null);
    } else if (name === 'publish.json') {
      const publish = toPublishSummary(o.customMetadata);
      const sub = decodeId(owner);
      if (!publish || sub === null) continue;
      published.push({
        owner,
        sub,
        tourId,
        title: null,
        slug: publish.slug,
        visibility: publish.visibility,
        at: o.uploaded.toISOString(),
      });
    }
  }

  const since = now.getTime() - DAY_MS;
  let uploads24h = 0;
  for (const o of uploads.objects) {
    const rest = o.key.slice(UPLOAD_LOG_ROOT.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue;
    // The daily limit's own window: entries older than 24 hours are pruned by upload-api.
    if (!(uploadLogTime(rest.slice(slash + 1)) >= since)) continue;
    of(rest.slice(0, slash)).uploads24h += 1;
    uploads24h += 1;
  }

  // The owner segment decodes to the sub; one that doesn't is no account to show.
  const rows = [...byOwner.values()].flatMap((a) => {
    const sub = decodeId(a.owner);
    if (sub === null) return [];
    const { owner: _owner, ...counts } = a;
    return [{ sub, ...counts }];
  });
  const accounts = rows.filter((a) => a.panos > 0 || a.tours > 0);
  return {
    partial: panos.partial || tours.partial || uploads.partial,
    totals: {
      accounts: accounts.length,
      panos: accounts.reduce((s, a) => s + a.panos, 0),
      originalBytes: accounts.reduce((s, a) => s + a.originalBytes, 0),
      tours: accounts.reduce((s, a) => s + a.tours, 0),
      shared: published.length,
      public: published.filter((p) => p.visibility === 'public').length,
      uploads24h,
    },
    heaviest: [...accounts]
      .sort((a, b) => b.originalBytes - a.originalBytes || b.panos - a.panos)
      .slice(0, ACCOUNT_ROWS),
    busiest: rows
      .filter((a) => a.uploads24h > 0)
      .sort((a, b) => b.uploads24h - a.uploads24h)
      .slice(0, ACCOUNT_ROWS),
    recentlyPublished: published
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, ACCOUNT_ROWS)
      .map(({ owner: _owner, ...p }) => ({ ...p, title: titles.get(p.tourId) ?? null })),
  };
};
