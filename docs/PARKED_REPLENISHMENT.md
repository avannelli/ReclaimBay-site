# Preserved unfinished replenishment work

On 2026-10-17 the interrupted replenishment implementation was removed from active
source and schema inputs and preserved in a **local Git stash**, on base `4069dc0`:

- Stash object: `b8fa3f11c29799dc91c700c96c64fd735a52c169`.
- Label: `WIP: unfinished replenishment parked for scanner strategic alignment; do not release`.
- Exactly four files, 216 added lines:
  - `backend/prisma/schema.prisma`: four proposed replenishment/screening models
    and two relation additions (78 lines).
  - `backend/src/replenishment/policy.ts`: proposed supply thresholds, scope
    validation and budget constants (34 lines).
  - `backend/src/replenishment/budget.ts`: unfinished HTTP budget reservation
    and accounting wrapper (57 lines).
  - `backend/src/replenishment/screen.ts`: unfinished official-site screening
    wrapper over existing fetch and analysis helpers (47 lines).

This is incomplete, unverified implementation. It has no migration, orchestration
service, source selection, CLI, scheduler integration, regression tests or
integration tests. It must not be treated as a working controller or included in
the next release. The active Prisma schema was restored to the committed version;
the three unfinished modules are absent from active source.

The stash is local to this clone and is not distributed by the documentation
commit. Do not drop it, reapply it or resume development without an explicit new
task. To inspect it without changing the working tree:

```sh
git stash show --include-untracked --stat b8fa3f11c29799dc91c700c96c64fd735a52c169
git stash show --include-untracked --patch b8fa3f11c29799dc91c700c96c64fd735a52c169
```

All unrelated, pre-existing `review/` artifacts were left untouched and excluded
from the strategic-alignment commit. No production access, migration, deployment,
acquisition-policy change or email was needed to park this work.
