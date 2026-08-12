// The one place the __verifyJwt name is typed. Not emitted into dist/, so it does
// not pollute consumers' global scope; test files reach the seam through
// @internal/worker-kit/testing instead.
declare global {
  // `var` is required here (`declare global` augmentations must use `var`, not
  // `let`/`const`). This repo's shared ESLint config does not enable `no-var`
  // (it is not part of eslint:recommended), so no disable directive is needed -
  // one was tried and ESLint's `reportUnusedDisableDirectives` (on by default in
  // flat config) failed the `--max-warnings 0` gate on the unused directive.
  var __verifyJwt: ((token: string) => Promise<{ sub: string }>) | undefined;
}

export {};
