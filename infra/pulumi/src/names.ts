/**
 * Logical (Pulumi) names and resource types, shared by the program and the
 * import-file script so an import always lands on the resource the program
 * declares. Renaming one of these makes Pulumi delete and recreate the
 * resource unless an `aliases` entry is added.
 */
export const RESOURCES = {
  bucket: { name: 'content-bucket', type: 'cloudflare:index/r2Bucket:R2Bucket' },
  bucketCors: { name: 'content-bucket-cors', type: 'cloudflare:index/r2BucketCors:R2BucketCors' },
  managedDomain: {
    name: 'content-bucket-r2-dev-domain',
    type: 'cloudflare:index/r2ManagedDomain:R2ManagedDomain',
  },
  cdnDomain: { name: 'cdn-domain', type: 'cloudflare:index/r2CustomDomain:R2CustomDomain' },
  uploadsQueue: { name: 'uploads-queue', type: 'cloudflare:index/queue:Queue' },
  deadLetterQueue: { name: 'uploads-dlq', type: 'cloudflare:index/queue:Queue' },
  uploadNotification: {
    name: 'upload-notification',
    type: 'cloudflare:index/r2BucketEventNotification:R2BucketEventNotification',
  },
  wafRuleset: { name: 'waf-custom-rules', type: 'cloudflare:index/ruleset:Ruleset' },
  rateLimitRuleset: { name: 'rate-limit-rules', type: 'cloudflare:index/ruleset:Ruleset' },
  cacheRuleset: { name: 'cache-rules', type: 'cloudflare:index/ruleset:Ruleset' },
  responseHeaderRuleset: {
    name: 'response-header-rules',
    type: 'cloudflare:index/ruleset:Ruleset',
  },
  redirectRuleset: { name: 'redirect-rules', type: 'cloudflare:index/ruleset:Ruleset' },
  hsts: { name: 'hsts', type: 'cloudflare:index/zoneSetting:ZoneSetting' },
  urlNormalization: {
    name: 'url-normalization',
    type: 'cloudflare:index/urlNormalizationSettings:UrlNormalizationSettings',
  },
  apexRecord: { name: 'apex-aaaa', type: 'cloudflare:index/dnsRecord:DnsRecord' },
  wwwRecord: { name: 'www-aaaa', type: 'cloudflare:index/dnsRecord:DnsRecord' },

  // --- Auth0 (src/auth0.ts) ---
  spaClient: { name: 'auth0-spa', type: 'auth0:index/client:Client' },
  spaCredentials: {
    name: 'auth0-spa-credentials',
    type: 'auth0:index/clientCredentials:ClientCredentials',
  },
  api: { name: 'auth0-api', type: 'auth0:index/resourceServer:ResourceServer' },
  googleConnection: { name: 'auth0-google', type: 'auth0:index/connection:Connection' },
  googleConnectionClients: {
    name: 'auth0-google-clients',
    type: 'auth0:index/connectionClients:ConnectionClients',
  },
  databaseConnectionClients: {
    name: 'auth0-database-clients',
    type: 'auth0:index/connectionClients:ConnectionClients',
  },
  attackProtection: {
    name: 'auth0-attack-protection',
    type: 'auth0:index/attackProtection:AttackProtection',
  },
  linkingClient: { name: 'auth0-link-accounts-client', type: 'auth0:index/client:Client' },
  linkingCredentials: {
    name: 'auth0-link-accounts-credentials',
    type: 'auth0:index/clientCredentials:ClientCredentials',
  },
  linkingGrant: { name: 'auth0-link-accounts-grant', type: 'auth0:index/clientGrant:ClientGrant' },
  banListAction: { name: 'auth0-ban-list-action', type: 'auth0:index/action:Action' },
  linkAccountsAction: { name: 'auth0-link-accounts-action', type: 'auth0:index/action:Action' },
  postLoginActions: {
    name: 'auth0-post-login-actions',
    type: 'auth0:index/triggerActions:TriggerActions',
  },

  // --- GitHub (src/github.ts): repository-wide, on one stack only ---
  githubRepository: { name: 'github-repository', type: 'github:index/repository:Repository' },
  githubWorkflowPermissions: {
    name: 'github-workflow-permissions',
    type: 'github:index/workflowRepositoryPermissions:WorkflowRepositoryPermissions',
  },
  githubMainProtection: {
    name: 'github-main-protection',
    type: 'github:index/branchProtectionV3:BranchProtectionV3',
  },
  githubAccountIdVariable: {
    name: 'github-variable-cloudflare-account-id',
    type: 'github:index/actionsVariable:ActionsVariable',
  },
  githubDevAutoDeployVariable: {
    name: 'github-variable-dev-auto-deploy',
    type: 'github:index/actionsVariable:ActionsVariable',
  },
  githubInfraPreviewEnvironment: {
    name: 'github-environment-infra-preview',
    type: 'github:index/repositoryEnvironment:RepositoryEnvironment',
  },
  // --- GitHub: each stack's own Environment (`dev`, `production`) ---
  githubEnvironment: {
    name: 'github-environment',
    type: 'github:index/repositoryEnvironment:RepositoryEnvironment',
  },
  githubEnvironmentMainPolicy: {
    name: 'github-environment-main-policy',
    type: 'github:index/repositoryEnvironmentDeploymentPolicy:RepositoryEnvironmentDeploymentPolicy',
  },
} as const;

export type ResourceKey = keyof typeof RESOURCES;

/** Each zone entrypoint ruleset and the phase it owns. */
export const RULESET_PHASES = {
  wafRuleset: 'http_request_firewall_custom',
  rateLimitRuleset: 'http_ratelimit',
  cacheRuleset: 'http_request_cache_settings',
  responseHeaderRuleset: 'http_response_headers_transform',
  redirectRuleset: 'http_request_dynamic_redirect',
} as const satisfies Partial<Record<ResourceKey, string>>;
