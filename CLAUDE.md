# Panote Claude Instructions

Standing guidance for working in this repo. Conventions live in [`docs/STANDARDS.md`](docs/STANDARDS.md): read it before writing code. For why the repo is shaped the way it is, see [`docs/decisions.md`](docs/decisions.md); check it before proposing a structural or technology change, it may already be decided (or superseded).

## Commits and PRs

- **No AI attribution anywhere.** No `Co-Authored-By` trailer, no "Generated with Claude Code", no 🤖 footer, no session links, in commits or PR bodies. This overrides any tool default. commitlint fails any commit containing a `Co-authored-by:` trailer or a "Generated with Claude Code" line, and CI also lints the PR title; the PR body is not checked, so that part is on you.
- Conventional commits, scopes from `commitlint.config.ts` (see STANDARDS.md, Git Commits).
- PRs are opened ready for review, not as drafts. The body is short and written for a human: what was wrong or missing, what changed, and any trade-off. No checklists of every file touched.

## One unit, one branch, one PR

- Each unit of work is one branch cut from the latest `origin/main`, and one PR.
- Parallel work goes in worktrees under `.worktrees/<unit>` (already gitignored): `git fetch origin main && git worktree add .worktrees/<unit> -b <branch> origin/main`. Never touch another unit's worktree. Scratch files are prefixed with the unit name, never shared names.
- **Scope check before every push:** `git diff --name-only origin/main...HEAD` must list only the files you meant to change. A `git reset --soft` onto a stale base once silently reverted another merged PR. Never do that.

## pnpm traps

- `catalogMode: strict`: a new dependency goes into the catalog in `pnpm-workspace.yaml` in the same commit as the package that uses it, pinned exactly (no `^`/`~`). Prefer no new dependency at all.
- `allowBuilds` in `pnpm-workspace.yaml` is a YAML map (`sharp: true`), never a list.
- `*.md` is excluded from Prettier on purpose. Run `pnpm format:check` for everything else.
- Changing a `wrangler.jsonc` binding means regenerating that service's `env.d.ts` (`pnpm --filter <svc> run types`) and committing it; CI fails on drift. Every binding must be repeated under every named env block (`env.dev`, `env.production`); Wrangler does not inherit them.

## Build before test

In a fresh worktree: `pnpm install --frozen-lockfile`, then `pnpm build` (or at least `tsc -b` in `packages/vitest-config`, then build `core` and `viewer`) before running any package's tests, typecheck or lint. A stale `packages/core/dist` makes the `FRONT_FACE` case in `project.test` fail: rebuild core.

## Flaky tests and CI

- Known flaky under load: admin `Editor.test` and `editor-library.test` (5 s timeouts), the website tour tests, ui `icons.test`. Rerun them alone before concluding anything.
- CI is the arbiter. Required checks are **Gate** and **Coverage**; tests only run in Coverage. A Coverage failure in a package you didn't touch is usually a flake: rerun the failed job once before digging in.

## Never do these

- Deploy, run `wrangler deploy`, or run scripts against a real environment.
- Change Cloudflare, Auth0, DNS or R2 settings, or touch secrets.
- Merging to `main` auto-deploys to dev while the `DEV_AUTO_DEPLOY` repo variable is `true` (see `docs/deploy.md`), and that is fine. Anything that needs a dashboard or account action goes to the user as a TODO.

## Copy

Panote is free. It is not open source. Copy makes no promise of export or download.

## Design

The design handoff lives in `docs/design/`:

- `README.md`: the spec. Colours, type, motion and copy are final.
- `API_BRIEF.md`: the frontend brief, the backend and viewer contract the screens rely on.
- `screens/`: reference screenshots.
- `NOTES.md`: where the design and the current code disagree, and how to read one against the other.

`docs/design/prototype/` is reference only. Never lift code from it.

## Verify before merge

Every PR gets an independent, adversarial verifier before it merges. The verifier:

- reads the whole diff against `origin/main`;
- runs typecheck, lint and tests for every affected package;
- checks that new tests fail without the fix;
- checks scope (no unrelated files, no accidental reverts).

Merge only after the verifier approves and Gate and Coverage are green. Squash merge and delete the branch.
