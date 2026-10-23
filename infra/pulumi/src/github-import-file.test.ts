import { describe, expect, it, vi } from 'vitest';

import { buildGithubImportPlan, githubGet, type GithubGet } from './github-import-file.js';
import { RESOURCES, type ResourceKey } from './names.js';
import { stackSettings, stackSettingsWithGithub } from './test-support.js';

const REPO = '/repos/joeldn/panote';

/** A read-only API double: path → response body, anything else 404s. */
function fakeApi(responses: Record<string, unknown>): GithubGet & { paths: string[] } {
  const paths: string[] = [];
  const get = async (path: string) => {
    paths.push(path);
    return responses[path];
  };
  return Object.assign(get, { paths });
}

const policies = (environment: string) =>
  `${REPO}/environments/${environment}/deployment-branch-policies?per_page=100`;

/** What the repository has today, set up by hand. */
const LIVE = {
  [REPO]: { full_name: 'joeldn/panote' },
  // `main` reads as protected under a ruleset too; only this is the classic rule.
  [`${REPO}/branches/main`]: { name: 'main', protected: true },
  [`${REPO}/branches/main/protection`]: {
    required_status_checks: { contexts: ['Gate', 'Coverage'] },
  },
  [`${REPO}/actions/variables/CLOUDFLARE_ACCOUNT_ID`]: { name: 'CLOUDFLARE_ACCOUNT_ID' },
  [`${REPO}/actions/variables/DEV_AUTO_DEPLOY`]: { name: 'DEV_AUTO_DEPLOY', value: 'true' },
  [`${REPO}/environments/infra-preview`]: { name: 'infra-preview' },
  [`${REPO}/environments/dev`]: { name: 'dev' },
  [policies('dev')]: {
    branch_policies: [
      { id: 7, name: 'release/*', type: 'branch' },
      { id: 9, name: 'main', type: 'tag' },
      { id: 11, name: 'main', type: 'branch' },
    ],
  },
  [`${REPO}/environments/production`]: { name: 'production' },
  [policies('production')]: { branch_policies: [{ id: 21, name: 'main' }] },
};

const entry = (key: ResourceKey, id: string) => ({
  type: RESOURCES[key].type,
  name: RESOURCES[key].name,
  id,
});

describe('buildGithubImportPlan', () => {
  it("imports dev's repository-wide settings and its Environment, with the ids they need", async () => {
    const api = fakeApi(LIVE);
    const plan = await buildGithubImportPlan(stackSettingsWithGithub('dev'), api);
    expect(plan.resources).toEqual([
      entry('githubRepository', 'panote'),
      entry('githubWorkflowPermissions', 'panote'),
      entry('githubMainProtection', 'panote:main'),
      entry('githubAccountIdVariable', 'panote:CLOUDFLARE_ACCOUNT_ID'),
      entry('githubDevAutoDeployVariable', 'panote:DEV_AUTO_DEPLOY'),
      entry('githubInfraPreviewEnvironment', 'panote:infra-preview'),
      entry('githubEnvironment', 'panote:dev'),
      entry('githubEnvironmentMainPolicy', 'panote:dev:11'),
    ]);
    expect(plan.missing).toEqual([]);
    // Production's Environment belongs to the production stack.
    expect(api.paths.some((path) => path.includes('production'))).toBe(false);
  });

  it("imports only production's Environment on production", async () => {
    const api = fakeApi(LIVE);
    const plan = await buildGithubImportPlan(stackSettingsWithGithub('production'), api);
    expect(plan.resources).toEqual([
      entry('githubEnvironment', 'panote:production'),
      entry('githubEnvironmentMainPolicy', 'panote:production:21'),
    ]);
    expect(api.paths).toEqual([REPO, `${REPO}/environments/production`, policies('production')]);
  });

  it('plans whatever is not there yet as new', async () => {
    const plan = await buildGithubImportPlan(
      stackSettingsWithGithub('dev'),
      fakeApi({
        [REPO]: { full_name: 'joeldn/panote' },
      }),
    );
    expect(plan.resources.map((e) => e.name)).toEqual([
      'github-repository',
      'github-workflow-permissions',
    ]);
    expect(plan.missing).toEqual([
      'github-main-protection',
      'github-variable-cloudflare-account-id',
      'github-variable-dev-auto-deploy',
      'github-environment-infra-preview',
      'github-environment',
      'github-environment-main-policy',
    ]);
  });

  it.each([
    ['main has no protection at all', { [`${REPO}/branches/main`]: { protected: false } }],
    ['main is protected only by a ruleset', { [`${REPO}/branches/main`]: { protected: true } }],
  ])('plans the classic rule as new when %s', async (_, branch) => {
    const { [`${REPO}/branches/main/protection`]: _rule, ...withoutRule } = LIVE;
    const api = fakeApi({ ...withoutRule, ...branch });
    const plan = await buildGithubImportPlan(stackSettingsWithGithub('dev'), api);
    expect(plan.missing).toEqual(['github-main-protection']);
    expect(plan.resources.map((e) => e.name)).not.toContain('github-main-protection');
    expect(api.paths).toContain(`${REPO}/branches/main/protection`);
  });

  it('plans the main policy as new when the Environment allows any branch', async () => {
    const plan = await buildGithubImportPlan(
      stackSettingsWithGithub('production'),
      fakeApi({ ...LIVE, [policies('production')]: { branch_policies: [] } }),
    );
    expect(plan.resources).toEqual([entry('githubEnvironment', 'panote:production')]);
    expect(plan.missing).toEqual(['github-environment-main-policy']);
  });

  it.each([
    ['the stack names no owner', stackSettings('dev'), LIVE, /names no GitHub owner/],
    [
      'the repository is not there',
      stackSettingsWithGithub('dev'),
      { ...LIVE, [REPO]: undefined },
      /joeldn\/panote not found/,
    ],
    [
      'two main policies',
      stackSettingsWithGithub('production'),
      {
        ...LIVE,
        [policies('production')]: {
          branch_policies: [
            { id: 1, name: 'main' },
            { id: 2, name: 'main' },
          ],
        },
      },
      /2 main policies/,
    ],
    [
      'a policy without an id',
      stackSettingsWithGithub('production'),
      { ...LIVE, [policies('production')]: { branch_policies: [{ name: 'main' }] } },
      /policy has no id/,
    ],
    [
      'the policies are not a list',
      stackSettingsWithGithub('production'),
      { ...LIVE, [policies('production')]: { branch_policies: {} } },
      /no branch_policies list/,
    ],
  ])('stops when %s', async (_, settings, responses, error) => {
    await expect(buildGithubImportPlan(settings, fakeApi(responses))).rejects.toThrow(error);
  });
});

describe('githubGet', () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('GETs the REST API with the token and returns the body', async () => {
    const fetchImpl = vi.fn(async () => response(200, { name: 'panote' }));
    const get = githubGet('tok', fetchImpl as unknown as typeof fetch);
    await expect(get('/repos/joeldn/panote')).resolves.toEqual({ name: 'panote' });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/joeldn/panote', {
      headers: {
        Authorization: 'Bearer tok',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  });

  it('maps 404 to undefined', async () => {
    const get = githubGet('tok', (async () => response(404, {})) as unknown as typeof fetch);
    await expect(get('/x')).resolves.toBeUndefined();
  });

  it('throws with the message and the permission a fine-grained token lacks', async () => {
    const get = githubGet('tok', (async () =>
      response(
        403,
        { message: 'Resource not accessible by personal access token' },
        { 'x-accepted-github-permissions': 'actions_variables=read' },
      )) as unknown as typeof fetch);
    await expect(get('/x')).rejects.toThrow(
      'GET /x: HTTP 403 (Resource not accessible by personal access token); the token needs actions_variables=read',
    );
    const bare = githubGet(
      'tok',
      (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(bare('/y')).rejects.toThrow(/^GET \/y: HTTP 500$/);
  });
});
