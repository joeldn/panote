import { describe, expect, it } from 'vitest';

import { membersKey, tourKey, tourOwnerKey } from './keys.js';
import {
  EMPTY_MEMBERS,
  hashInviteSecret,
  InviteEmailSchema,
  newInviteToken,
  parseInviteToken,
  resolveTourAccess,
  type AccessStore,
  type TourMembers,
} from './members.js';

const store = (objects: Record<string, unknown>): AccessStore => ({
  exists: async (key) => key in objects,
  readJson: async (key) => objects[key] ?? null,
});

const OWNER = 'auth0|owner';
const EDITOR = 'auth0|editor';
const withEditor: TourMembers = {
  ...EMPTY_MEMBERS,
  members: [
    { id: 'm1', sub: EDITOR, email: 'e@example.com', role: 'editor', addedAt: '2026-10-23' },
  ],
};
const shared = {
  [tourKey(OWNER, 't1')]: {},
  [tourOwnerKey('t1')]: { v: 1, sub: OWNER },
  [membersKey(OWNER, 't1')]: withEditor,
};

describe('resolveTourAccess', () => {
  it('knows the owner by their own tour.json', async () => {
    expect(await resolveTourAccess(store(shared), OWNER, 't1')).toEqual({
      owner: OWNER,
      role: 'owner',
      members: null,
    });
  });

  it("knows an editor through the owner pointer and the owner's members.json", async () => {
    expect(await resolveTourAccess(store(shared), EDITOR, 't1')).toEqual({
      owner: OWNER,
      role: 'editor',
      members: withEditor,
    });
  });

  it('refuses anyone else', async () => {
    expect(await resolveTourAccess(store(shared), 'auth0|x', 't1')).toBeNull();
  });

  it('refuses without a pointer, an unreadable members.json, or the tour gone', async () => {
    const { [tourOwnerKey('t1')]: _p, ...noPointer } = shared;
    expect(await resolveTourAccess(store(noPointer), EDITOR, 't1')).toBeNull();
    expect(
      await resolveTourAccess(
        store({ ...shared, [membersKey(OWNER, 't1')]: { v: 2 } }),
        EDITOR,
        't1',
      ),
    ).toBeNull();
    const { [tourKey(OWNER, 't1')]: _t, ...noTour } = shared;
    expect(await resolveTourAccess(store(noTour), EDITOR, 't1')).toBeNull();
  });

  it('refuses a pointer that names the caller without their tour.json', async () => {
    expect(
      await resolveTourAccess(
        store({
          [tourOwnerKey('t1')]: { v: 1, sub: EDITOR },
          [membersKey(EDITOR, 't1')]: withEditor,
        }),
        EDITOR,
        't1',
      ),
    ).toBeNull();
  });

  it('refuses a bad tourId before reading anything', async () => {
    const touched: string[] = [];
    const spy: AccessStore = {
      exists: async (k) => (touched.push(k), false),
      readJson: async (k) => (touched.push(k), null),
    };
    expect(await resolveTourAccess(spy, EDITOR, '../x')).toBeNull();
    expect(touched).toEqual([]);
  });
});

describe('invite tokens', () => {
  it('round-trips the tourId and stores only a hash of the secret', async () => {
    const { token, tokenHash } = await newInviteToken('tour-1');
    const parsed = parseInviteToken(token);
    expect(parsed?.tourId).toBe('tour-1');
    expect(await hashInviteSecret(parsed!.secret)).toBe(tokenHash);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(tokenHash);
  });

  it('makes a different token every time', async () => {
    const a = await newInviteToken('tour-1');
    const b = await newInviteToken('tour-1');
    expect(a.token).not.toBe(b.token);
  });

  it.each(['', 'tour-1', 'tour-1.short', `bad id.${'A'.repeat(43)}`, `t.${'A'.repeat(44)}`])(
    'refuses %j',
    (token) => {
      expect(parseInviteToken(token)).toBeNull();
    },
  );
});

describe('InviteEmailSchema', () => {
  it('lower-cases and trims, like the email claim', () => {
    expect(InviteEmailSchema.parse('  Maya@Example.COM ')).toBe('maya@example.com');
  });

  it.each(['maya', 'maya@', '@example.com', 'a b@example.com', 'maya@example'])(
    'refuses %j',
    (email) => {
      expect(InviteEmailSchema.safeParse(email).success).toBe(false);
    },
  );
});
