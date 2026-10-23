import * as github from '@pulumi/github';
import type * as pulumi from '@pulumi/pulumi';

import { RESOURCES, type ResourceKey } from './names.js';
import type { GithubSettings, Settings } from './settings.js';

/**
 * The checks `main` requires (ci.yml's two jobs), by name. The GraphQL
 * resource can't pin a check to the GitHub Actions app as the hand-made rule
 * does (docs/decisions.md), so a status of the same name from anyone with
 * write access to statuses would count too.
 */
export const REQUIRED_CHECKS = ['Gate', 'Coverage'] as const;
export const PROTECTED_BRANCH = 'main';

/**
 * How pull requests merge: squash only, and the branch goes once merged
 * (CLAUDE.md). The squash commit's title and message stay as they were set.
 */
export const MERGE_SETTINGS = {
  allowSquashMerge: true,
  allowMergeCommit: false,
  allowRebaseMerge: false,
  allowAutoMerge: false,
  allowUpdateBranch: false,
  deleteBranchOnMerge: true,
  squashMergeCommitTitle: 'COMMIT_OR_PR_TITLE',
  squashMergeCommitMessage: 'COMMIT_MESSAGES',
} as const;

/**
 * Repository fields the program leaves to the dashboard. An imported value is
 * kept as it is, so the provider's defaults never switch off issues, the wiki
 * or anything else nobody decided here.
 */
export const LEFT_ALONE = [
  'description',
  'homepageUrl',
  'topics',
  'visibility',
  'private',
  'hasIssues',
  'hasWiki',
  'hasProjects',
  'hasDiscussions',
  'hasDownloads',
  'isTemplate',
  'pages',
  'template',
  'securityAndAnalysis',
  'vulnerabilityAlerts',
  'webCommitSignoffRequired',
  'mergeCommitTitle',
  'mergeCommitMessage',
] as const;

/** Workflows get a read-only `GITHUB_TOKEN` and can never approve a pull request. */
export const WORKFLOW_PERMISSIONS = {
  defaultWorkflowPermissions: 'read',
  canApprovePullRequestReviews: false,
} as const;

/** The repository variables the program declares, by resource. */
export const VARIABLES = {
  githubAccountIdVariable: 'CLOUDFLARE_ACCOUNT_ID',
  githubDevAutoDeployVariable: 'DEV_AUTO_DEPLOY',
} as const satisfies Partial<Record<ResourceKey, string>>;

/** The Environment `infra-preview.yml` runs in. */
export const INFRA_PREVIEW_ENVIRONMENT = 'infra-preview';

type Track = <T extends pulumi.CustomResource>(key: ResourceKey, resource: T) => T;

/**
 * Declares what this stack owns on GitHub: its own Environment (named after
 * the stack, as deploy.yml uses it) and, on the one stack with
 * `repositoryWide`, the repository's settings, `main`'s protection, the
 * repository variables and the `infra-preview` Environment. Secrets are not
 * here: their values come from nowhere Pulumi can read (infra/README.md).
 */
export function createGithub(settings: Settings, gh: GithubSettings, track: Track): void {
  const repository = gh.repository;
  const userId = (login: string) =>
    github.getUserOutput({ username: login }).apply((user) => Number(user.id));
  const reviewedBy = (login: string) => ({
    reviewers: [{ users: [userId(login)] }],
    // The reviewer is also the one who starts the run; true would lock him out.
    preventSelfReview: false,
  });

  // --- This stack's Environment: main only --------------------------------------
  const environment = track(
    'githubEnvironment',
    new github.RepositoryEnvironment(
      RESOURCES.githubEnvironment.name,
      {
        repository,
        environment: settings.stack,
        deploymentBranchPolicy: { protectedBranches: false, customBranchPolicies: true },
        ...(gh.environmentReviewer === undefined ? {} : reviewedBy(gh.environmentReviewer)),
      },
      // Deleting an Environment deletes its secrets (the deploy token).
      { protect: true },
    ),
  );
  track(
    'githubEnvironmentMainPolicy',
    new github.RepositoryEnvironmentDeploymentPolicy(RESOURCES.githubEnvironmentMainPolicy.name, {
      repository,
      environment: environment.environment,
      branchPattern: PROTECTED_BRANCH,
    }),
  );

  const wide = gh.repositoryWide;
  if (!wide) return;

  // --- The repository ------------------------------------------------------------------
  const repo = track(
    'githubRepository',
    new github.Repository(
      RESOURCES.githubRepository.name,
      { name: repository, ...MERGE_SETTINGS, archiveOnDestroy: true },
      // Deleting this resource would delete the repository: protected, and
      // archived rather than deleted if the protection is ever lifted.
      { protect: true, ignoreChanges: [...LEFT_ALONE] },
    ),
  );
  track(
    'githubWorkflowPermissions',
    new github.WorkflowRepositoryPermissions(RESOURCES.githubWorkflowPermissions.name, {
      repository,
      ...WORKFLOW_PERMISSIONS,
    }),
  );

  // --- main: the two checks, no force push, no deletion ------------------------------
  // The GraphQL resource: the REST one (BranchProtectionV3) only works on an
  // organization's repository, and joeldn/panote is a user's. Admins are not
  // held to it and no review is required: Joel merges his own pull requests
  // (infra/README.md, GitHub; docs/decisions.md).
  track(
    'githubMainProtection',
    new github.BranchProtection(RESOURCES.githubMainProtection.name, {
      repositoryId: repo.nodeId,
      pattern: PROTECTED_BRANCH,
      enforceAdmins: false,
      allowsForcePushes: false,
      allowsDeletions: false,
      requiredStatusChecks: [{ strict: false, contexts: [...REQUIRED_CHECKS] }],
    }),
  );

  // --- Repository variables (docs/deploy.md, GitHub setup) ------------------------------
  const values: Record<keyof typeof VARIABLES, string> = {
    // One Cloudflare account for both environments: the stacks' own.
    githubAccountIdVariable: settings.accountId,
    githubDevAutoDeployVariable: String(wide.devAutoDeploy),
  };
  for (const [key, variableName] of Object.entries(VARIABLES) as [
    keyof typeof VARIABLES,
    string,
  ][]) {
    track(
      key,
      new github.ActionsVariable(RESOURCES[key].name, {
        repository,
        variableName,
        value: values[key],
      }),
    );
  }

  // --- infra-preview: a reviewer, since a run holds the passphrase ----------------------
  // No branch rule: its runs are pull requests, never main.
  track(
    'githubInfraPreviewEnvironment',
    new github.RepositoryEnvironment(
      RESOURCES.githubInfraPreviewEnvironment.name,
      {
        repository,
        environment: INFRA_PREVIEW_ENVIRONMENT,
        ...reviewedBy(wide.infraPreviewReviewer),
      },
      { protect: true },
    ),
  );
}
