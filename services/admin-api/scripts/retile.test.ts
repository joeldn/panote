import { describe, expect, it } from 'vitest';

import {
  currentEtag,
  findTargets,
  notificationFor,
  parseRetileArgs,
  resolveQueueId,
  SEND_BATCH,
  sendToQueue,
} from './retile-lib.ts';
import type { FetchLike } from './takedown-lib.ts';

const ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_BUCKET: 'pano-content-dev',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
};

describe('parseRetileArgs', () => {
  it('is a dry run unless --apply, and maps the bucket to its upload queue', () => {
    expect(parseRetileArgs(['--pano', 'p1', '--pano', 'p2', '--pano', 'p1'], ENV)).toMatchObject({
      panos: ['p1', 'p2'],
      apply: false,
      queue: 'pano-uploads-dev',
    });
    expect(parseRetileArgs(['--all'], ENV).panos).toBeNull();
  });

  it('needs CF_QUEUES_TOKEN only with --apply', () => {
    expect(() => parseRetileArgs(['--all', '--apply'], ENV)).toThrow(/CF_QUEUES_TOKEN/);
    expect(parseRetileArgs(['--all', '--apply'], { ...ENV, CF_QUEUES_TOKEN: 't' })).toMatchObject({
      apply: true,
      apiToken: 't',
    });
  });

  it.each([
    [[], /--pano, or pass --all/],
    [['--all', '--pano', 'p1'], /--pano, or pass --all/],
    [['--pano'], /needs a value/],
    [['--pano', '--all'], /needs a value/],
    [['--pano', 'a/b'], /--pano must match/],
    [['--all', '--force'], /unknown argument --force/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseRetileArgs(argv, ENV)).toThrow(error);
  });

  it('makes a non-dev bucket be named twice', () => {
    const prod = { ...ENV, R2_BUCKET: 'pano-content' };
    expect(() => parseRetileArgs(['--all'], prod)).toThrow(/--allow-bucket/);
    expect(parseRetileArgs(['--all', '--allow-bucket', 'pano-content'], prod).queue).toBe(
      'pano-uploads',
    );
  });

  it('refuses a bucket with no known queue', () => {
    expect(() =>
      parseRetileArgs(['--all', '--allow-bucket', 'other'], { ...ENV, R2_BUCKET: 'other' }),
    ).toThrow(/no upload queue/);
  });
});

describe('findTargets', () => {
  const listed = [
    { key: 'panos/o1/p1/original', size: 10 },
    { key: 'panos/o1/p1/config.json', size: 1 },
    { key: 'panos/o1/p2/config.json', size: 1 },
    { key: 'panos/o2/p3/original', size: 30 },
    { key: 'panos/o2/p3/deleting', size: 0 },
    { key: 'panos/o2/p4/original', size: 40 },
  ];

  it('finds every original, skipping panos mid-delete', () => {
    expect(findTargets(listed, null)).toEqual({
      targets: [
        { panoId: 'p1', key: 'panos/o1/p1/original', size: 10 },
        { panoId: 'p4', key: 'panos/o2/p4/original', size: 40 },
      ],
      deleting: ['p3'],
      missing: [],
    });
  });

  it('narrows to the named panos and reports those with no original', () => {
    expect(findTargets(listed, ['p4', 'p2', 'p3'])).toEqual({
      targets: [{ panoId: 'p4', key: 'panos/o2/p4/original', size: 40 }],
      deleting: ['p3'],
      missing: ['p2'],
    });
  });
});

describe('currentEtag', () => {
  it('strips the quotes, and is null for a gone original', async () => {
    expect(
      await currentEtag({ head: async () => ({ ok: true, status: 200, etag: '"e1"' }) }, 'k'),
    ).toBe('e1');
    expect(
      await currentEtag({ head: async () => ({ ok: false, status: 404, etag: null }) }, 'k'),
    ).toBeNull();
    await expect(
      currentEtag({ head: async () => ({ ok: false, status: 500, etag: null }) }, 'k'),
    ).rejects.toThrow('500');
  });
});

describe('notificationFor', () => {
  it('matches the R2 object-create event tiler-consumer reads', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    expect(
      notificationFor({ panoId: 'p1', key: 'panos/o1/p1/original', size: 10 }, 'e1', ENV_R2, now),
    ).toEqual({
      account: 'acct',
      bucket: 'pano-content-dev',
      action: 'PutObject',
      object: { key: 'panos/o1/p1/original', size: 10, eTag: 'e1' },
      eventTime: '2026-10-01T00:00:00.000Z',
    });
  });
});
const ENV_R2 = { accountId: 'acct', bucket: 'pano-content-dev' };

describe('Queues API calls', () => {
  const recorder = (respond: (url: string) => Response) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return respond(url);
    };
    return { calls, fetchFn };
  };

  it('resolves the queue id by name', async () => {
    const { calls, fetchFn } = recorder(() =>
      Response.json({
        result: [
          { queue_id: 'q-other', queue_name: 'pano-uploads-dlq-dev' },
          { queue_id: 'q-1', queue_name: 'pano-uploads-dev' },
        ],
      }),
    );
    expect(await resolveQueueId(fetchFn, 'acct', 'tok', 'pano-uploads-dev')).toBe('q-1');
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/queues');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    await expect(resolveQueueId(fetchFn, 'acct', 'tok', 'nope')).rejects.toThrow(/not found/);
  });

  it('sends in batches of SEND_BATCH as JSON messages', async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ success: true }));
    const bodies = Array.from({ length: SEND_BATCH + 1 }, (_, i) => ({ i }));
    expect(await sendToQueue(fetchFn, 'acct', 'tok', 'q-1', bodies)).toBe(SEND_BATCH + 1);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/acct/queues/q-1/messages/batch',
      'https://api.cloudflare.com/client/v4/accounts/acct/queues/q-1/messages/batch',
    ]);
    const first = JSON.parse(String(calls[0]!.init.body)) as { messages: unknown[] };
    expect(first.messages).toHaveLength(SEND_BATCH);
    expect(first.messages[0]).toEqual({ body: { i: 0 }, content_type: 'json' });
  });

  it('stops at a failed batch, saying how many went', async () => {
    const { fetchFn } = recorder(() =>
      Response.json({ errors: [{ message: 'denied' }] }, { status: 403 }),
    );
    await expect(sendToQueue(fetchFn, 'acct', 'tok', 'q-1', [{}])).rejects.toThrow(
      /after 0 sent -> 403 .*denied/,
    );
  });
});
