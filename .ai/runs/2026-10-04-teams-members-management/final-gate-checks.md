# Final gate — spec complete

**Date:** 2026-10-04T16:30:00Z (initial) / re-verified 2026-10-04T18:20:00Z after resume fixes
**Branch:** feat/teams-members-management → `develop`
**PR:** https://github.com/piotrchabros/cal.diy/pull/9

## Full validation gate (`validation.commands`) — resume re-run on final tree
- `yarn type-check:ci --force` → 9/9 tasks successful (post-merge 0014ffa and post-fix).
- `yarn lint` → 11/11 tasks successful (warnings/infos are repo-wide pre-existing).
- `TZ=UTC yarn test` → full suite: 2 files flaky under parallel load in this environment
  (`calendar-subscriptions` cron + webhook route tests, 8+10 timeouts at 10s); both files pass
  9/9 and 11/11 in isolation and with `--no-file-parallelism`, mock prisma/services, and have
  zero code overlap with this diff (teams/membership vs calendar-subscription) — environment
  resource contention, not a code defect. Teams suites: 23/23 pass
  (`TeamMembersService.test.ts` 14, `teamsMutations.handler.test.ts` 9, incl. new
  accepted-filter and getTeam regression tests).

## Integration suite
- No browser/E2E harness in this environment; unit coverage stands in:
  `TeamMembersService.test.ts` (11 tests: list/invite/accept/role/remove/myTeams + guards),
  `teamsMutations.handler.test.ts` (7 tests: all procedures forward ctx/input correctly).
- Risky flows (last-owner guards, pending accept, token invites) covered at service level.

## Design-system / style pass
- Biome lint-staged clean on every Step commit; full `yarn lint` green.
- UI uses repo components only (`SettingsHeader`, `Table`, `Badge`, `Avatar`, `Dropdown`,
  `Pagination`, `Dialog`/`ConfirmationDialogContent`, `TextField`, `Select`, `EmptyScreen`,
  `Alert`, `Checkbox`, `Skeleton`); direct `@calcom/ui/components/*` + `@coss/ui` imports
  per convention; no new dependencies; no schema changes.

## Gauntlet UI verdict (Step 3.1)
- Blind structural A/B vs `teams/team members.png`: header, toolbar (Search/Display/Filter),
  table (checkbox/Member/Role badges/Last active/row actions), pagination footer, invite
  dialog, confirmations, permission gating — all match on #4-scoped pieces.
- Remaining deltas are sibling scope: 3-level sidebar nesting + Team profile pages (#2/#5),
  `+ Add a team` create flow (#3).
