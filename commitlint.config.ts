import { RuleConfigSeverity, type UserConfig } from '@commitlint/types';

/**
 * Conventional Commits. Changesets drives versioning, but commit subjects still
 * have to be machine-readable so the changelog and the release notes line up.
 */
const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      RuleConfigSeverity.Warning,
      'always',
      [
        // apps
        'website',
        'admin',
        'demo',
        // services
        'public-api',
        'admin-api',
        'upload-api',
        'tiler-consumer',
        // packages
        'viewer',
        'core',
        'tiler',
        'contracts',
        'worker-kit',
        'api-client',
        // shared config packages
        'typescript-config',
        'eslint-config',
        'vitest-config',
        // repo-level
        'repo',
        'ci',
        'deps',
      ],
    ],
    // Changesets pastes long release notes into commit bodies; wrapping them
    // is not worth failing a commit over.
    'body-max-line-length': [RuleConfigSeverity.Disabled],
  },
};

export default config;
