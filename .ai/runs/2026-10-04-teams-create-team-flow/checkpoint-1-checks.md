# Checkpoint 1 — Steps 0.1–2.4 (backend + form UI + validation wiring)

Date: 2026-10-04T15:30:00Z · Branch: `feat/teams-create-team-flow`

## Covered steps

- 0.1 run folder + draft PR #6 (Fixes #3), three-signal claim on PR + issue #3
- 1.1 `TeamCreationService` (select-only Prisma, ErrorWithCode, OWNER membership) + 9 unit tests
- 1.2 tRPC `viewer.teams.create` / `viewer.teams.isSlugAvailable` + registration in viewer router
- 2.1 18 new i18n keys in `en/common.json` (valid JSON, existing keys reused where present)
- 2.2 `teams/new` page (session check + redirect in page.tsx) + form + public preview panel
- 2.3 live validation: debounced `useTeamSlugAvailability` hook + `validateTeamLogoFile` + 4 tests
- 2.4 Biome autofix pass (format/sorted-classes); remaining lint warnings match pre-existing
  repo patterns (verified parity on `apiKeys/_router.tsx`)

## Validation (targeted subset)

- `vitest run packages/features/teams/`: 2 files, 13 tests — ALL PASS
- `biome lint` on new/changed files: exit 0, 0 errors (18 warnings, all nursery/style
  warnings of kinds already present in the repo; `noUnusedVariables` cache-type pattern
  identical to existing routers)
- `biome check --write` applied; tests re-run green after formatting
- Full `validation.commands` gate deferred to final gate (Step 3.2)

## UI verification

Deferred to Step 3.1 (gauntlet-loop): dev-server render at 1256x852 + blind A/B vs bar.
Reason: needs running web app + screenshot harness; batched with the polish pass.

## Scope check

No sibling surfaces touched: no `/teams` list, no members, no profile-settings files.
No schema migration. No secrets. `select` only; no `credential.key`; no `as any`.
