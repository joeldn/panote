import { RuleConfigSeverity, type Plugin, type UserConfig } from '@commitlint/types';

// Enforces docs/STANDARDS.md's rule against co-author attribution. Checked
// against parsed.raw so it also catches messages commitlint's footer
// parser wouldn't otherwise recognize as having a footer.
const noCoAuthoredByTrailer: Plugin = {
  rules: {
    'no-co-authored-by-trailer': (parsed) => {
      const message = parsed.raw ?? '';
      const hasTrailer = /^\s*co-authored-by:/im.test(message);
      const hasGeneratedWithLine = /generated with \[?claude code/i.test(message);
      return [
        !hasTrailer && !hasGeneratedWithLine,
        'commit message must not contain a "Co-authored-by:" trailer or a "Generated with Claude Code" line (docs/STANDARDS.md: no co-author attributions in commit messages or PRs)',
      ];
    },
  },
};

/**
 * Conventional Commits. Changesets drives versioning, but commit subjects still
 * have to be machine-readable so the changelog and the release notes line up.
 */
const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  plugins: [noCoAuthoredByTrailer],
  rules: {
    // Hard rule so nobody has to remember to strip it by hand. Plugin rules
    // register under their bare name, not prefixed by the plugin key.
    'no-co-authored-by-trailer': [RuleConfigSeverity.Error, 'always'],
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
