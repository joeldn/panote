import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type * as Action from './ban-list.cjs';

// CommonJS on purpose (pasted into Auth0 as it is), so load it that way.
const load = createRequire(import.meta.url);
const action = load('./ban-list.cjs') as typeof Action;
const { DENY_REASON, emailHash, emailsOf, isBanned, normaliseEmail, parseBanList } = action;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const fakeApi = () => ({ access: { deny: vi.fn() } });

describe('normaliseEmail', () => {
  it.each([
    ['  Maya@Example.com ', 'maya@example.com'],
    ['maya+panote@example.com', 'maya@example.com'],
    ['M.a.y.a+x@GoogleMail.com', 'maya@gmail.com'],
    ['m.aya@gmail.com', 'maya@gmail.com'],
    // Dots only matter to Gmail.
    ['m.aya@example.com', 'm.aya@example.com'],
    ['+only@example.com', '+only@example.com'],
    ['not-an-email', 'not-an-email'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseEmail(input)).toBe(expected);
  });

  it('hashes the normalised form', async () => {
    expect(await emailHash('Maya+x@Example.com')).toBe(sha256('maya@example.com'));
  });
});

describe('parseBanList', () => {
  it('reads hashes separated by commas, spaces or newlines, and drops anything else', () => {
    const a = sha256('a@example.com');
    const b = sha256('b@example.com');
    const list = parseBanList(` ${a.toUpperCase()},\n${b} , not-a-hash, ${a.slice(1)} `);
    expect([...list].sort()).toEqual([a, b].sort());
  });

  it('is empty without the secret', () => {
    expect(parseBanList(undefined).size).toBe(0);
    expect(parseBanList('').size).toBe(0);
  });
});

describe('isBanned: a malformed list', () => {
  it('warns with how many entries it ignored, never what they were', async () => {
    const log = vi.fn();
    const secret = `${sha256('banned@gmail.com')}, oops@example.com,${'a'.repeat(63)}`;
    const banned = await isBanned(
      { user: { email: 'banned@gmail.com' }, secrets: { BANNED_EMAIL_SHA256: secret } },
      log,
    );
    expect(banned).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    const line = log.mock.calls.flat().join(' ');
    expect(line).toContain('2 BANNED_EMAIL_SHA256 entries');
    expect(line).not.toContain('oops');
    expect(line).not.toContain('aaaa');
  });

  it('stays quiet when every entry is a hash, or there are none', async () => {
    const log = vi.fn();
    const secrets = { BANNED_EMAIL_SHA256: ` ${sha256('x@example.com')} ,\n` };
    await isBanned({ user: { email: 'maya@example.com' }, secrets }, log);
    await isBanned({ user: { email: 'maya@example.com' } }, log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('emailsOf', () => {
  it('takes the root email and each linked identity’s', () => {
    expect(
      emailsOf({
        email: 'maya@example.com',
        identities: [{}, { profileData: { email: 'other@example.com' } }, { profileData: {} }],
      }),
    ).toEqual(['maya@example.com', 'other@example.com']);
    expect(emailsOf({})).toEqual([]);
  });
});

describe('onExecutePostLogin', () => {
  const secrets = { BANNED_EMAIL_SHA256: `${sha256('banned@gmail.com')},${'0'.repeat(64)}` };

  it('refuses a sign-in whose email is banned, in any trivial variant', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const email of ['banned@gmail.com', 'B.anned+new@googlemail.com']) {
      const api = fakeApi();
      await action.onExecutePostLogin({ user: { email }, secrets }, api);
      expect(api.access.deny).toHaveBeenCalledExactlyOnceWith(DENY_REASON);
    }
    // The log names neither the address nor the user.
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/banned@|gmail/);
    log.mockRestore();
  });

  it('refuses a user carrying a banned address on a linked identity', async () => {
    expect(
      await isBanned({
        user: {
          email: 'fresh@example.com',
          identities: [{ profileData: { email: 'banned@gmail.com' } }],
        },
        secrets,
      }),
    ).toBe(true);
  });

  it('lets everyone else in', async () => {
    const api = fakeApi();
    await action.onExecutePostLogin({ user: { email: 'maya@example.com' }, secrets }, api);
    await action.onExecutePostLogin({ user: {}, secrets }, api);
    expect(api.access.deny).not.toHaveBeenCalled();
  });

  it('refuses nobody while the secret is missing or empty', async () => {
    const api = fakeApi();
    await action.onExecutePostLogin({ user: { email: 'banned@gmail.com' } }, api);
    await action.onExecutePostLogin(
      { user: { email: 'banned@gmail.com' }, secrets: { BANNED_EMAIL_SHA256: '' } },
      api,
    );
    expect(api.access.deny).not.toHaveBeenCalled();
  });
});

describe('scripts/ban-email.cjs', () => {
  const script = fileURLToPath(new URL('../scripts/ban-email.cjs', import.meta.url));

  it('prints the hash the Action matches, and only that, on stdout', async () => {
    const out = execFileSync(process.execPath, [script, 'B.anned+x@gmail.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(out.trim()).toBe(sha256('banned@gmail.com'));
    expect(
      await isBanned({
        user: { email: 'banned@gmail.com' },
        secrets: { BANNED_EMAIL_SHA256: out },
      }),
    ).toBe(true);
  });

  it('refuses something that is not an address', () => {
    expect(() => execFileSync(process.execPath, [script, 'nope'], { stdio: 'ignore' })).toThrow();
  });
});
