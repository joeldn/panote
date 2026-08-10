import type { Config } from 'prettier';

/**
 * Prettier is run directly (`pnpm format` / `pnpm format:check`), not through
 * ESLint. `eslint-config-prettier` is applied in the shared ESLint config to
 * turn off every rule that would fight with these settings.
 */
const config: Config = {
  singleQuote: true,
  tabWidth: 2,
  semi: true,
  trailingComma: 'all',
  printWidth: 100,
  endOfLine: 'lf',
  overrides: [
    {
      // YAML is whitespace-significant and single quotes there mean something
      // different; keep Prettier's YAML defaults but hold the width down so
      // pnpm-workspace.yaml stays readable in side-by-side diffs.
      files: ['*.yaml', '*.yml'],
      options: {
        singleQuote: true,
        printWidth: 80,
        tabWidth: 2,
      },
    },
    {
      // Markdown is currently excluded via .prettierignore (see the comment
      // there). This override is kept so that if Markdown is ever brought back
      // under the gate, it comes back without prose re-wrapping.
      files: ['*.md'],
      options: {
        proseWrap: 'preserve',
      },
    },
  ],
};

export default config;
