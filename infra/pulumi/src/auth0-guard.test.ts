import { afterEach, describe, expect, it } from 'vitest';

import { createInfra } from './infra.js';
import type { Settings } from './settings.js';
import { installMocks, stackSettings } from './test-support.js';

/**
 * The whole program with an empty link-accounts secret, as the provider reads
 * it back without `read:client_keys`: `up` must fail, a preview must not.
 * Each case sets its own mocks, so they live in a file of their own.
 */
const DEV_WITH_TENANT: Settings = {
  ...stackSettings('dev'),
  auth0: { domain: 'panote-dev.au.auth0.com', localDevCallbacks: true },
};

type Listener = (...args: unknown[]) => void;
let saved: Listener[] = [];
afterEach(() => {
  process.removeAllListeners('unhandledRejection');
  for (const listener of saved) process.on('unhandledRejection', listener);
  saved = [];
});

/**
 * Runs the program and returns why it failed, if it did. A failed input fails
 * every resource that depends on it, and the SDK reports each as an unhandled
 * rejection, so they are collected here instead of failing the test file.
 */
async function programFailures(): Promise<string[]> {
  saved = process.listeners('unhandledRejection') as Listener[];
  process.removeAllListeners('unhandledRejection');
  const failures: string[] = [];
  process.on('unhandledRejection', (reason) => failures.push(String(reason)));
  const infra = createInfra(DEV_WITH_TENANT);
  const urns = Object.values(infra.resources).map((resource) =>
    (resource.urn as unknown as { promise(): Promise<string> }).promise(),
  );
  for (const result of await Promise.allSettled(urns)) {
    if (result.status === 'rejected') failures.push(String(result.reason));
  }
  // Let the SDK's own rejections arrive.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return failures;
}

describe('an empty link-accounts secret', () => {
  it('stops an up', async () => {
    await installMocks({ preview: false, linkingSecret: '' });
    const failures = await programFailures();
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) expect(failure).toMatch(/read:client_keys/);
  });

  it('passes a preview, which never deploys it', async () => {
    await installMocks({ preview: true, linkingSecret: '' });
    expect(await programFailures()).toEqual([]);
  });

  it('is fine in an up when the secret is there', async () => {
    await installMocks({ preview: false });
    expect(await programFailures()).toEqual([]);
  });
});
