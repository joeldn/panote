import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeId,
  FLAGS_ROOT,
  FlagRecordSchema,
  manifestKey,
  ogKey,
  previewKey,
} from '@internal/contracts';
import { afterTiling, tiledFrom } from './consumer.js';
import { readVerdict, screenPano, SCREEN_MODEL } from './screen.js';
import { uploaderOf } from './upload-prefix.js';

// Storage is shared across cases, so each uses its own panoId.

const tiled = async (panoId: string, manifest: object = { preview: true }) => {
  await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ version: 't1-v', ...manifest }));
  await env.BUCKET.put(previewKey(panoId, 't1-v'), new Uint8Array([1, 2, 3]));
  await env.BUCKET.put(ogKey(panoId, 't1-v'), new Uint8Array([4, 5, 6]));
};

const model = (...answers: (unknown | Error)[]) => {
  const run = vi.fn(async (_model: string, _input: unknown) => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { response: next };
  });
  return { ai: { run } as unknown as Ai, run };
};

/** Every flag stored for this pano. */
const flagsFor = async (panoId: string) => {
  const page = await env.BUCKET.list({ prefix: FLAGS_ROOT });
  const all = await Promise.all(
    page.objects.map(async (o) =>
      FlagRecordSchema.parse(await (await env.BUCKET.get(o.key))!.json()),
    ),
  );
  return all.filter((f) => f.panoId === panoId);
};

const NOW = new Date('2026-10-23T12:00:00.000Z');

afterEach(() => vi.restoreAllMocks());

describe('readVerdict', () => {
  it('reads JSON mode objects and JSON inside text, and keeps only known categories', () => {
    expect(readVerdict({ categories: [] })).toEqual({ categories: [] });
    expect(readVerdict({ categories: ['violence', 'cats', 'violence'], reason: ' gore ' })).toEqual(
      { categories: ['violence'], reason: 'gore' },
    );
    expect(readVerdict('Sure! {"categories": ["sexual"]} done')).toEqual({
      categories: ['sexual'],
    });
  });

  it('is null for anything else', () => {
    expect(readVerdict('no json here')).toBeNull();
    expect(readVerdict('{not json}')).toBeNull();
    expect(readVerdict({ verdict: 'ok' })).toBeNull();
    expect(readVerdict(undefined)).toBeNull();
  });

  it('caps the reason', () => {
    expect(readVerdict({ categories: ['hate'], reason: 'x'.repeat(400) })?.reason).toHaveLength(
      300,
    );
  });
});

describe('screenPano', () => {
  it('sends the whole-sphere preview to the model, and stores nothing when it sees nothing', async () => {
    await tiled('sc-clear');
    const { ai, run } = model({ categories: [] });
    expect(await screenPano({ bucket: env.BUCKET, ai, now: NOW }, 'sc-clear', 'auth0|a')).toEqual({
      outcome: 'clear',
    });
    expect(run).toHaveBeenCalledOnce();
    const [name, input] = run.mock.calls[0]!;
    expect(name).toBe(SCREEN_MODEL);
    expect(JSON.stringify(input)).toContain('data:image/webp;base64,AQID');
    expect(await flagsFor('sc-clear')).toEqual([]);
  });

  it('stores a hit as a screening flag in the review queue, naming the uploader', async () => {
    await tiled('sc-hit');
    const { ai } = model({ categories: ['violence'], reason: 'A bloody scene.' });
    const got = await screenPano({ bucket: env.BUCKET, ai, now: NOW }, 'sc-hit', 'auth0|b');
    expect(got.outcome).toBe('flagged');
    expect(await flagsFor('sc-hit')).toEqual([
      expect.objectContaining({
        source: 'screening',
        panoId: 'sc-hit',
        version: 't1-v',
        owner: 'auth0|b',
        categories: ['violence'],
        summary: 'A bloody scene.',
        at: NOW.toISOString(),
      }),
    ]);
  });

  it('falls back to og.jpg when the model refuses the preview', async () => {
    await tiled('sc-fallback', { preview: true, og: true });
    const { ai, run } = model(new Error('bad image'), { categories: [] });
    const got = await screenPano({ bucket: env.BUCKET, ai, now: NOW }, 'sc-fallback', 'auth0|c');
    expect(got.outcome).toBe('clear');
    expect(JSON.stringify(run.mock.calls[1]![1])).toContain('data:image/jpeg;base64,BAUG');
  });

  it('fails, never throws, when there is nothing to check or no usable answer', async () => {
    const deps = (ai: Ai) => ({ bucket: env.BUCKET, ai, now: NOW });
    expect(await screenPano(deps(model().ai), 'sc-none', 'auth0|d')).toEqual({
      outcome: 'failed',
      why: 'no manifest',
    });
    await tiled('sc-noimg', { preview: undefined });
    expect((await screenPano(deps(model().ai), 'sc-noimg', 'auth0|d')).outcome).toBe('failed');
    await tiled('sc-junk');
    expect(await screenPano(deps(model('I cannot help').ai), 'sc-junk', 'auth0|d')).toEqual({
      outcome: 'failed',
      why: 'unreadable answer',
    });
    expect(await screenPano(deps(model(new TypeError('x')).ai), 'sc-junk', 'auth0|d')).toEqual({
      outcome: 'failed',
      why: 'model: TypeError',
    });
    expect(await flagsFor('sc-junk')).toEqual([]);
  });
});

describe('screenPano timeout', () => {
  it('gives up on a model that doesn’t answer', async () => {
    await tiled('sc-slow', { preview: true });
    const ai = { run: () => new Promise(() => undefined) } as unknown as Ai;
    expect(
      await screenPano({ bucket: env.BUCKET, ai, now: NOW, timeoutMs: 5 }, 'sc-slow', 'auth0|e'),
    ).toEqual({ outcome: 'failed', why: 'model: ScreenTimeout' });
  });
});

describe('tiledFrom', () => {
  it('matches a version to the original it was tiled from, quoted ETag or not', () => {
    expect(tiledFrom('t3-abc', 'abc')).toBe(true);
    expect(tiledFrom('t3-abc', '"abc"')).toBe(true);
    expect(tiledFrom('t2-abc', 'abc')).toBe(true);
    expect(tiledFrom('t3-abc', 'def')).toBe(false);
    expect(tiledFrom(null, 'abc')).toBe(false);
    expect(tiledFrom('t3-abc', undefined)).toBe(false);
  });
});

describe('afterTiling', () => {
  const run = async (panoId: string, answer: unknown, extra: Partial<Env> = {}) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await tiled(panoId);
    const send = vi.fn(async () => ({ messageId: 'm1' }));
    const panoTiled = vi.fn(async () => 1);
    const writeDataPoint = vi.fn<(p: AnalyticsEngineDataPoint) => void>();
    await afterTiling(
      {
        ...env,
        ALERT_EMAIL_TO: 'ops@example.test',
        ALERT_EMAIL: { send } as unknown as SendEmail,
        OPS_EVENTS: { writeDataPoint },
        AI: model(answer).ai,
        MODERATION: { panoTiled } as never,
        ...extra,
      },
      `panos/${encodeId('auth0|owner')}/${panoId}/original`,
      panoId,
    );
    const events = writeDataPoint.mock.calls.map(([p]) => [p.blobs?.[0], p.blobs?.[1]]);
    return { send, panoTiled, events };
  };

  it('emails a severe hit, with no owner in it, and re-queues Explore tours either way', async () => {
    const { send, panoTiled, events } = await run('at-severe', { categories: ['sexual'] });
    expect(events).toEqual([
      ['pano-screened', 'flagged'],
      ['explore-requeue', 'done'],
    ]);
    expect(send).toHaveBeenCalledOnce();
    const mail = JSON.stringify(send.mock.calls[0]);
    expect(mail).toContain('at-severe');
    expect(mail).toContain('/app/ops/flags');
    expect(mail).not.toContain('auth0|owner');
    expect(panoTiled).toHaveBeenCalledWith('at-severe');
    expect((await flagsFor('at-severe'))[0]).toMatchObject({ owner: 'auth0|owner' });
  });

  it('only flags a hit that is not severe, and sends nothing when clear', async () => {
    const hate = await run('at-hate', { categories: ['hate'] });
    expect(hate.events).toEqual([
      ['pano-screened', 'flagged'],
      ['explore-requeue', 'done'],
    ]);
    expect(hate.send).not.toHaveBeenCalled();
    const clear = await run('at-clear', { categories: [] });
    expect(clear.events).toEqual([
      ['pano-screened', 'clear'],
      ['explore-requeue', 'done'],
    ]);
    expect(clear.send).not.toHaveBeenCalled();
    expect(clear.panoTiled).toHaveBeenCalledWith('at-clear');
  });

  it('a failing entrypoint or email is logged, counted and never thrown', async () => {
    const down = vi.fn(async () => {
      throw new Error('admin-api down');
    });
    const { events } = await run(
      'at-down',
      { categories: ['child-safety'] },
      {
        MODERATION: { panoTiled: down } as never,
        ALERT_EMAIL: { send: down } as unknown as SendEmail,
      },
    );
    // The screening alert, the entrypoint, then the alert that the re-queue failed.
    expect(down).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      ['pano-screened', 'flagged'],
      ['explore-requeue', 'failed'],
    ]);
  });

  it('emails the operator when the Explore re-queue fails', async () => {
    const send = vi.fn(async () => ({ messageId: 'm2' }));
    const failing = vi.fn(async () => {
      throw new Error('down');
    });
    await run(
      'at-requeue',
      { categories: [] },
      {
        MODERATION: { panoTiled: failing } as never,
        ALERT_EMAIL: { send } as unknown as SendEmail,
      },
    );
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(send.mock.calls[0])).toContain(
      'Explore re-review failed for pano at-requeue',
    );
  });

  it('does nothing for a re-tile of the same original', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = vi.fn();
    const panoTiled = vi.fn();
    await afterTiling(
      { ...env, AI: { run } as unknown as Ai, MODERATION: { panoTiled } as never },
      `panos/${encodeId('auth0|owner')}/at-same/original`,
      'at-same',
      true,
    );
    expect(run).not.toHaveBeenCalled();
    expect(panoTiled).not.toHaveBeenCalled();
  });
});

describe('uploaderOf', () => {
  it('decodes the owner segment of an original key, and is null for any other key', () => {
    expect(uploaderOf(`panos/${encodeId('auth0|x')}/p1/original`)).toBe('auth0|x');
    expect(uploaderOf('panos/p1/original')).toBeNull();
    expect(uploaderOf('panos/a.b/p1/original')).toBeNull();
  });
});
