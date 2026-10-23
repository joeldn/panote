import type { AccountView } from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'linked') {
      return {
        sub: 'google-oauth2|1',
        email: 'maya@example.com',
        linkedSubs: ['email|2', 'apple|3', 'google-oauth2|4'],
      };
    }
    if (t === 'plain') return { sub: 'facebook|5' };
    throw new Error('bad');
  });
});

const account = (token: string) =>
  SELF.fetch('https://x/api/admin/account', { headers: { Authorization: `Bearer ${token}` } });

describe('GET /api/admin/account', () => {
  it('lists the sign-ins linked into the account, its own first, once each', async () => {
    const r = await account('linked');
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toContain('no-store');
    expect(await r.json<AccountView>()).toEqual({
      email: 'maya@example.com',
      signIns: ['google-oauth2', 'email', 'apple'],
    });
  });

  it('says there is no verified email when the token has none', async () => {
    expect(await (await account('plain')).json<AccountView>()).toEqual({
      email: null,
      signIns: ['facebook'],
    });
  });

  it('needs a signed-in user', async () => {
    expect((await account('nope')).status).toBe(401);
  });
});
