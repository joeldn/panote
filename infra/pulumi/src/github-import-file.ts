import { INFRA_PREVIEW_ENVIRONMENT, PROTECTED_BRANCH, VARIABLES } from './github.js';
import type { ImportEntry } from './import-file.js';
import { RESOURCES, type ResourceKey } from './names.js';
import type { Settings } from './settings.js';

/**
 * Builds the `pulumi import --file` document for what a stack owns on GitHub,
 * all of which was set up by hand, by reading the REST API. Read-only: it
 * only ever GETs.
 *
 * Like import-file.ts, names and types come from names.ts. The repository and
 * its Actions workflow permissions always exist; `main`'s classic protection, the
 * variables, the Environments and their `main` branch policy are looked up and
 * planned as new when they aren't there.
 */

/** GET a REST API path (`/repos/...`); `undefined` on 404. */
export type GithubGet = (path: string) => Promise<unknown>;

export interface GithubImportPlan {
  resources: ImportEntry[];
  /** Resources the program declares that don't exist yet: `pulumi up` creates them. */
  missing: string[];
}

export async function buildGithubImportPlan(
  settings: Settings,
  get: GithubGet,
): Promise<GithubImportPlan> {
  const gh = settings.github;
  if (!gh) throw new Error(`the ${settings.stack} stack names no GitHub owner (github:owner)`);
  const { owner, repository } = gh;
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const resources: ImportEntry[] = [];
  const missing: string[] = [];
  const add = (key: ResourceKey, id: string | undefined) => {
    const { type, name } = RESOURCES[key];
    if (id === undefined) missing.push(name);
    else resources.push({ type, name, id });
  };
  const environmentId = async (environment: string) =>
    (await get(`${repo}/environments/${encodeURIComponent(environment)}`)) === undefined
      ? undefined
      : `${repository}:${environment}`;

  const found = (await get(repo)) as { full_name?: unknown } | undefined;
  if (found === undefined) throw new Error(`${owner}/${repository} not found`);

  if (gh.repositoryWide) {
    add('githubRepository', repository);
    // Every repository has Actions workflow permissions.
    add('githubWorkflowPermissions', repository);
    // The classic rule itself: a branch's `protected` is also true under a
    // ruleset alone, which this resource can't import. 404 means no rule.
    const protection = await get(`${repo}/branches/${PROTECTED_BRANCH}/protection`);
    add(
      'githubMainProtection',
      protection === undefined ? undefined : `${repository}:${PROTECTED_BRANCH}`,
    );
    for (const [key, name] of Object.entries(VARIABLES) as [keyof typeof VARIABLES, string][]) {
      const variable = await get(`${repo}/actions/variables/${name}`);
      add(key, variable === undefined ? undefined : `${repository}:${name}`);
    }
    add('githubInfraPreviewEnvironment', await environmentId(INFRA_PREVIEW_ENVIRONMENT));
  }

  // This stack's own Environment and its `main` branch policy.
  const environment = settings.stack;
  const envId = await environmentId(environment);
  add('githubEnvironment', envId);
  let policyId: string | undefined;
  if (envId !== undefined) {
    const body = (await get(
      `${repo}/environments/${environment}/deployment-branch-policies?per_page=100`,
    )) as { branch_policies?: unknown } | undefined;
    const policies = body?.branch_policies ?? [];
    if (!Array.isArray(policies)) throw new Error(`${environment}: no branch_policies list`);
    const main = (policies as Record<string, unknown>[]).filter(
      (p) => p.name === PROTECTED_BRANCH && (p.type ?? 'branch') === 'branch',
    );
    if (main.length > 1)
      throw new Error(`${environment}: ${main.length} ${PROTECTED_BRANCH} policies`);
    const id = main[0]?.id;
    if (main.length === 1 && typeof id !== 'number')
      throw new Error(`${environment}: policy has no id`);
    if (typeof id === 'number') policyId = `${repository}:${environment}:${id}`;
  }
  add('githubEnvironmentMainPolicy', policyId);

  return { resources, missing };
}

/** A `GithubGet` over `fetch`, for the CLI. */
export function githubGet(token: string, fetchImpl: typeof fetch = fetch): GithubGet {
  return async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 404) return undefined;
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const message = (body as { message?: unknown } | undefined)?.message;
      // A fine-grained token that lacks a permission is told which one.
      const wanted = res.headers.get('x-accepted-github-permissions');
      throw new Error(
        `GET ${path}: HTTP ${res.status}${message ? ` (${String(message)})` : ''}${
          wanted ? `; the token needs ${wanted}` : ''
        }`,
      );
    }
    return body;
  };
}
