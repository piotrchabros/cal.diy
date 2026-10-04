# Final gate — 2026-10-04-teams-profile-settings

**Date:** 2026-10-04 (resume run, PR #7)
**Branch:** feat/5-teams-profile-settings @ 29587c2 (plus this commit)

## Validation gate (`validation.commands`)

- `yarn type-check:ci --force` — **PASS** (9/9 turbo tasks, ran after all code edits)
- `yarn lint` — **PASS** (11/11 turbo tasks; biome shows only repo-normal nursery infos, same class as merged #6 files, zero errors)
- `TZ=UTC yarn test` — **PASS** (405 files passed / 5 skipped, 4111 tests passed, 0 failed; 7 jsdom `_location` uncaught-exception noise lines in untouched files: timezone TimezoneSelect, editor AddVariablesDropdown, users-public-view — pre-existing env noise, no failures)

## Integration suite (`om-integration-tests`)

- **SKIPPED with reason:** no provisioned test environment in sandbox (no `.ai/qa/test-env.json`, no running dev server or test database). Coverage instead: `TeamProfileService.test.ts` (permissions, slug uniqueness, owner-only disband) + `TeamCreationService.test.ts` + `validateTeamLogoFile.test.ts` — 24/24 pass. Gauntlet UI comparison done statically against the reference bar (see 3.1): header, form card fields, URL prefix, readonly ID + copy, B/I/link editor + hint, location + map checkbox (now controlled via RHF Controller), socials + add button, dirty-aware Update + toasts, owner-only danger-zone + confirm modal, minimal My-teams sidebar entry.

## Style-compliance pass

- Biome on touched files: no errors; only nursery `useExplicitType` infos (repo-normal).
- Conventions verified: `select` (never `include`) in all Prisma queries; `import type` for types; direct `@calcom/ui/components/*` imports; `ErrorWithCode` in service layer; permission checks in `page.tsx`; conventional commits; no `as any`; i18n keys present in `en/common.json` with reference-matching copy.

## Merge-base freshness

- Merged `origin/develop` (incl. #6 create-team flow) into the task branch as 9c136e2; resolved add/add conflict in `viewer/teams/_router.tsx` (combined create/isSlugAvailable + getProfile/updateProfile/disband) and a duplicated `teams: teamsRouter` line in `viewer/_router.tsx`.
