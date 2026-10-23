/**
 * Per-stack settings, read from `Pulumi.<stack>.yaml` (namespace
 * `panote-infra`). Everything that differs between dev and production is here;
 * the program itself has no `if (stack === 'dev')`.
 */
export interface Settings {
  /** `dev` or `production`; the stack name. */
  readonly stack: 'dev' | 'production';
  readonly accountId: string;
  /** The zone the site and its CDN live on: `panote.dev` / `panote.io`. */
  readonly zone: string;
  readonly bucket: string;
  readonly uploadsQueue: string;
  readonly deadLetterQueue: string;
  /** File name under `infra/r2/`. */
  readonly corsFile: string;
  /** File name under `infra/cloudflare/`. */
  readonly cacheRulesFile: string;
  /** Dev only: `X-Robots-Tag: noindex, nofollow` on every response of the zone. */
  readonly noindexAllResponses: boolean;
  /** Production only: `www.<zone>` redirects to the apex. */
  readonly wwwRedirect: boolean;
}

/** The subset of `pulumi.Config` this module needs, so tests can pass a map. */
export interface ConfigSource {
  require(key: string): string;
  getBoolean(key: string): boolean | undefined;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const ZONE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const FILE_NAME = /^[A-Za-z0-9._-]+\.json$/;

/**
 * Reads and checks the stack's settings. Dev resources carry the `-dev`
 * suffix and production's never do (docs/STANDARDS.md), so a production stack
 * pointed at a dev name, or the other way round, fails here before anything
 * reaches Cloudflare.
 */
export function readSettings(stack: string, config: ConfigSource): Settings {
  if (stack !== 'dev' && stack !== 'production') {
    throw new Error(`unknown stack "${stack}": expected dev or production`);
  }
  const accountId = config.require('accountId');
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`accountId "${accountId}" is not an account id`);
  const zone = config.require('zone');
  if (!ZONE.test(zone)) throw new Error(`zone "${zone}" is not a zone name`);

  const names = {
    bucket: config.require('bucket'),
    uploadsQueue: config.require('uploadsQueue'),
    deadLetterQueue: config.require('deadLetterQueue'),
  };
  for (const [key, name] of Object.entries(names)) {
    if (!RESOURCE_NAME.test(name)) throw new Error(`${key} "${name}" is not a resource name`);
    const isDevName = name.endsWith('-dev');
    if (stack === 'dev' && !isDevName) throw new Error(`${key} "${name}" must end in -dev on dev`);
    if (stack === 'production' && isDevName) {
      throw new Error(`${key} "${name}" is a dev name; production must not use it`);
    }
  }

  const corsFile = config.require('corsFile');
  const cacheRulesFile = config.require('cacheRulesFile');
  for (const [key, file] of Object.entries({ corsFile, cacheRulesFile })) {
    if (!FILE_NAME.test(file)) throw new Error(`${key} "${file}" is not a JSON file name`);
  }
  if (stack === 'production' && corsFile !== 'cors.json') {
    throw new Error(`production must use cors.json, not ${corsFile}`);
  }

  const noindexAllResponses = config.getBoolean('noindexAllResponses') ?? false;
  if (stack === 'production' && noindexAllResponses) {
    throw new Error('noindexAllResponses would hide production from search engines');
  }

  return {
    stack,
    accountId,
    zone,
    ...names,
    corsFile,
    cacheRulesFile,
    noindexAllResponses,
    wwwRedirect: config.getBoolean('wwwRedirect') ?? false,
  };
}
