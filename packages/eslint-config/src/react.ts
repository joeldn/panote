import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

import { base } from './base.js';

/**
 * React + browser variant, for the Vite SPAs in `apps/*`.
 *
 * Adds browser globals, the rules-of-hooks checks, and react-refresh's
 * "only export components" check that keeps Vite HMR working.
 */
export const react = tseslint.config(
  base,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  // `configs.flat.*` are the flat-config shapes; `configs['recommended-latest']`
  // (without `.flat`) is still the legacy eslintrc object.
  reactHooks.configs.flat['recommended-latest'],
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);

export default react;
