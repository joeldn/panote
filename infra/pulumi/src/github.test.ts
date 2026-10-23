import { readFileSync } from 'node:fs';

import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';

import { LEFT_ALONE } from './github.js';
import { RESOURCES, type ResourceKey } from './names.js';
import type { Settings } from './settings.js';
import {
  GITHUB_USER_IDS,
  inputsOf,
  installMocks,
  run,
  stackSettings,
  stackSettingsWithGithub,
  type Registered,
} from './test-support.js';

const REPO = new URL('../../../', import.meta.url);
const repoFile = (path: string) => readFileSync(new URL(path, REPO), 'utf8');

const GITHUB_KEYS = Object.keys(RESOURCES).filter((key) =>
  RESOURCES[key as ResourceKey].type.startsWith('github:'),
) as ResourceKey[];

/** The resource options each resource was declared with (mocks never see them). */
const options = new Map<string, pulumi.ResourceOptions>();

beforeAll(() => installMocks());

/**
 * `run`, inside a root stack whose transformation records each resource's
 * options, as the engine would get them.
 */
async function runRecordingOptions(settings: Settings) {
  let result: Awaited<ReturnType<typeof run>> | undefined;
  await pulumi.runtime.runInPulumiStack(async () => {
    pulumi.runtime.registerStackTransformation((args) => {
      options.set(args.name, args.opts);
      return undefined;
    });
    result = await run(settings);
    return {};
  });
  return result!;
}

const JOEL = GITHUB_USER_IDS.joeldn;
const DEV = stackSettingsWithGithub('dev');
const PRODUCTION = stackSettingsWithGithub('production');

const githubResources = (resources: Map<string, Registered>) =>
  [...resources.values()].filter((resource) => resource.type.startsWith('github:'));

/**
 * What a GitHub resource is on GitHub, whichever stack declares it: two
 * resources with the same identity would fight over one setting.
 */
function identity({ type, inputs }: Registered): string {
  const kind = type.split(':').pop();
  const repo = String(inputs.repository ?? inputs.name);
  const what = [inputs.environment, inputs.branch, inputs.variableName, inputs.branchPattern]
    .filter((part) => part !== undefined)
    .map(String);
  return [kind, repo, ...what].join(' ');
}

describe('the stacks', () => {
  it('declare nothing on GitHub until the import names the owner', async () => {
    for (const stack of ['dev', 'production'] as const) {
      const settings = stackSettings(stack);
      if (settings.github !== undefined) continue;
      const { resources } = await run(settings);
      expect(githubResources(resources)).toEqual([]);
    }
  });

  it('name joeldn/panote, if they name a repository at all', () => {
    for (const stack of ['dev', 'production'] as const) {
      const named = stackSettings(stack).github;
      if (named !== undefined)
        expect([named.owner, named.repository]).toEqual(['joeldn', 'panote']);
      expect(stackSettingsWithGithub(stack).github?.repository).toBe('panote');
    }
  });

  it('own every GitHub resource between them, and never the same one twice', async () => {
    const dev = githubResources((await run(DEV)).resources);
    const production = githubResources((await run(PRODUCTION)).resources);
    const devIds = dev.map(identity);
    const productionIds = production.map(identity);
    expect(new Set(devIds).size).toBe(devIds.length);
    expect(new Set(productionIds).size).toBe(productionIds.length);
    expect(devIds.filter((id) => productionIds.includes(id))).toEqual([]);
    expect(new Set([...dev, ...production].map((r) => r.name))).toEqual(
      new Set(GITHUB_KEYS.map((key) => RESOURCES[key].name)),
    );
  });

  it('give the repository-wide settings to dev and only dev', () => {
    expect(DEV.github?.repositoryWide).toEqual({
      infraPreviewReviewer: 'joeldn',
      devAutoDeploy: true,
    });
    expect(PRODUCTION.github?.repositoryWide).toBeUndefined();
  });
});

describe('dev', () => {
  let resources: Map<string, Registered>;
  beforeAll(async () => {
    ({ resources } = await runRecordingOptions(DEV));
  });

  it('merges by squash only and deletes the branch afterwards', () => {
    expect(inputsOf(resources, 'githubRepository')).toMatchObject({
      name: 'panote',
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: false,
      allowAutoMerge: false,
      deleteBranchOnMerge: true,
      archiveOnDestroy: true,
    });
  });

  it('leaves the description, topics, visibility and features to the dashboard', () => {
    const inputs = inputsOf(resources, 'githubRepository');
    const opts = options.get(RESOURCES.githubRepository.name);
    expect(opts?.protect).toBe(true);
    expect(opts?.ignoreChanges).toEqual([...LEFT_ALONE]);
    for (const field of [
      'description',
      'topics',
      'visibility',
      'private',
      'hasIssues',
      'hasWiki',
    ]) {
      expect(LEFT_ALONE).toContain(field);
      expect(inputs[field]).toBeUndefined();
    }
  });

  it('gives workflows a read-only token that cannot approve pull requests', () => {
    expect(inputsOf(resources, 'githubWorkflowPermissions')).toEqual({
      repository: 'panote',
      defaultWorkflowPermissions: 'read',
      canApprovePullRequestReviews: false,
    });
  });

  it("requires ci.yml's Gate and Coverage on main, blocks force pushes and deletion, no review", () => {
    const inputs = inputsOf(resources, 'githubMainProtection');
    expect(inputs).toEqual({
      repositoryId: `${RESOURCES.githubRepository.name}-node-id`,
      pattern: 'main',
      enforceAdmins: false,
      allowsForcePushes: false,
      allowsDeletions: false,
      requiredStatusChecks: [{ strict: false, contexts: ['Gate', 'Coverage'] }],
    });
    const ci = repoFile('.github/workflows/ci.yml');
    expect(ci).toMatch(/^ {4}name: Gate$/m);
    expect(ci).toMatch(/^ {4}name: Coverage$/m);
  });

  it('sets the repository variables deploy.yml reads', () => {
    expect(inputsOf(resources, 'githubAccountIdVariable')).toEqual({
      repository: 'panote',
      variableName: 'CLOUDFLARE_ACCOUNT_ID',
      value: stackSettings('production').accountId,
    });
    expect(inputsOf(resources, 'githubDevAutoDeployVariable')).toEqual({
      repository: 'panote',
      variableName: 'DEV_AUTO_DEPLOY',
      value: 'true',
    });
    const deploy = repoFile('.github/workflows/deploy.yml');
    expect(deploy).toContain('vars.CLOUDFLARE_ACCOUNT_ID');
    expect(deploy).toContain("vars.DEV_AUTO_DEPLOY == 'true'");
  });

  it('deploys to the dev Environment from main only, with no reviewer', () => {
    const inputs = inputsOf(resources, 'githubEnvironment');
    expect(inputs).toEqual({
      repository: 'panote',
      environment: 'dev',
      deploymentBranchPolicy: { protectedBranches: false, customBranchPolicies: true },
    });
    expect(inputsOf(resources, 'githubEnvironmentMainPolicy')).toEqual({
      repository: 'panote',
      environment: 'dev',
      branchPattern: 'main',
    });
  });

  it('holds every infra-preview run for its reviewer, who may approve his own', () => {
    expect(inputsOf(resources, 'githubInfraPreviewEnvironment')).toEqual({
      repository: 'panote',
      environment: 'infra-preview',
      reviewers: [{ users: [JOEL] }],
      preventSelfReview: false,
    });
    expect(repoFile('.github/workflows/infra-preview.yml')).toContain('environment: infra-preview');
  });

  it('protects the repository and the Environments, whose secrets would go with them', () => {
    for (const key of ['githubRepository', 'githubEnvironment', 'githubInfraPreviewEnvironment']) {
      expect(options.get(RESOURCES[key as ResourceKey].name)?.protect).toBe(true);
    }
  });

  it('turns DEV_AUTO_DEPLOY off when the stack says so', async () => {
    const off: Settings = {
      ...DEV,
      github: {
        ...DEV.github!,
        repositoryWide: { infraPreviewReviewer: 'joeldn', devAutoDeploy: false },
      },
    };
    const { resources: offResources } = await run(off);
    expect(inputsOf(offResources, 'githubDevAutoDeployVariable').value).toBe('false');
  });
});

describe('production', () => {
  it('owns only its Environment: main only, approved by its reviewer', async () => {
    const { resources } = await run(PRODUCTION);
    expect(
      githubResources(resources)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['github-environment', 'github-environment-main-policy']);
    expect(inputsOf(resources, 'githubEnvironment')).toEqual({
      repository: 'panote',
      environment: 'production',
      deploymentBranchPolicy: { protectedBranches: false, customBranchPolicies: true },
      reviewers: [{ users: [JOEL] }],
      preventSelfReview: false,
    });
    expect(inputsOf(resources, 'githubEnvironmentMainPolicy')).toMatchObject({
      environment: 'production',
      branchPattern: 'main',
    });
    expect(repoFile('.github/workflows/deploy.yml')).toContain(
      'environment: ${{ needs.resolve-environment.outputs.environment }}',
    );
  });
});
