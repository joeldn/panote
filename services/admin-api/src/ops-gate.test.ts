import { errorHandler } from '@internal/worker-kit/hono';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';

import { isOperatorSub, parseOperatorHashes, requireOperator, subHash } from './ops-gate.js';

// sha256('auth0|operator'), the one operator vitest.config.ts lists.
const OPERATOR_HASH = '9b411d3d5389f38a637a3c2a5d1b32ad931294b2ba105ae7f7d277c29ce6301e';

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'operator') return { sub: 'auth0|operator' };
    if (t === 'owner') return { sub: 'google-oauth2|owner' };
    throw new Error('bad');
  });
});

describe('subHash', () => {
  it('is the hex SHA-256 of the sub as written', async () => {
    expect(await subHash('auth0|operator')).toBe(OPERATOR_HASH);
    expect(await subHash('AUTH0|operator')).not.toBe(OPERATOR_HASH);
  });
});

describe('parseOperatorHashes', () => {
  it('keeps 64-hex entries, lowercased, split on commas or whitespace', () => {
    const h = parseOperatorHashes(` ${OPERATOR_HASH.toUpperCase()},abc\n${'0'.repeat(64)} `);
    expect([...h]).toEqual([OPERATOR_HASH, '0'.repeat(64)]);
  });

  it('is empty for an unset or blank var', () => {
    expect(parseOperatorHashes(undefined).size).toBe(0);
    expect(parseOperatorHashes('  ,  ').size).toBe(0);
  });
});

describe('isOperatorSub', () => {
  it('is true only for a listed sub', async () => {
    expect(await isOperatorSub(OPERATOR_HASH, 'auth0|operator')).toBe(true);
    expect(await isOperatorSub(OPERATOR_HASH, 'auth0|someone')).toBe(false);
  });

  it('lets nobody in when the list is empty', async () => {
    expect(await isOperatorSub('', 'auth0|operator')).toBe(false);
    expect(await isOperatorSub(undefined, 'auth0|operator')).toBe(false);
  });
});

describe('requireOperator', () => {
  const app = new Hono<{ Bindings: Env; Variables: { sub: string | undefined } }>();
  app.use('/ops/*', requireOperator);
  app.get('/ops/ping', (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  const get = (token?: string) =>
    app.request('/ops/ping', { headers: token ? { Authorization: `Bearer ${token}` } : {} }, env);

  it('lets an operator through, uncached', async () => {
    const res = await get('operator');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('answers anyone else as if the route did not exist', async () => {
    const res = await get('owner');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('404 Not Found');
  });

  it('wants a signed-in user first', async () => {
    expect((await get()).status).toBe(401);
  });
});

describe('the real /api/admin/ops routes', () => {
  const real = (path: string, token: string) =>
    SELF.fetch(`https://x${path}`, { headers: { Authorization: `Bearer ${token}` } });

  it('look to a non-operator exactly like a path that does not exist', async () => {
    const [ops, nope] = await Promise.all([
      real('/api/admin/ops', 'owner'),
      real('/api/admin/does-not-exist', 'owner'),
    ]);
    expect(ops.status).toBe(nope.status);
    expect(ops.headers.get('content-type')).toBe(nope.headers.get('content-type'));
    expect(await ops.text()).toBe(await nope.text());
    expect(ops.headers.get('Cache-Control')).toBeNull();
  });

  it('let an operator through the gate', async () => {
    for (const path of ['/api/admin/ops', '/api/admin/ops/anything']) {
      const res = await real(path, 'operator');
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });
});
