## What changed and why

<!-- Summarize the change and the problem it solves. Link the ticket/issue if there is one. -->

## Scope of impact

<!-- Which workspace(s) does this touch? apps/services/packages, dev vs prod, any binding or schema change. -->

-

## How this was verified

<!-- Commands run, tests added/passing, manual steps taken (e.g. `wrangler dev` against a `-dev` resource). -->

- [ ] `pnpm test` passes
- [ ] `pnpm lint` / `pnpm typecheck` pass
- [ ] Manually verified in `dev` (if the change touches a deployable Worker/app)

## Back-out procedure

<!-- If this needs to be reverted after deploy, what has to happen? -->

- [ ] Revertable with a straight `git revert` (no follow-up migration/data change required)
- [ ] No irreversible R2/Durable Object/Queue state changes shipped with this PR
- [ ] Rollback does not require a coordinated change to another service
