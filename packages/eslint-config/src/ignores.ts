/**
 * Paths no ESLint run in this monorepo should ever look at.
 *
 * Kept separate from the config bodies so that both the base and the react
 * variant share one definition, and so a consumer can extend rather than
 * replace it.
 */
export const commonIgnores: string[] = [
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/node_modules/**',
  '**/.turbo/**',
  '**/.wrangler/**',
  '**/*.tsbuildinfo',
];
