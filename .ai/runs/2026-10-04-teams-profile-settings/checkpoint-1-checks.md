# Checkpoint 1 — backend (Phase 1: Steps 1.1–1.3)

**Date:** 2026-10-04T15:30:00Z
**Scope:** tRPC `viewer.teams` surface — schemas, TeamProfileService, handlers, router wiring.

## Validation
- `yarn vitest run packages/features/teams/services/TeamProfileService.test.ts` → 1 file, 11 tests, all passed.
- `yarn tsc --noEmit -p packages/trpc/tsconfig.json` → exit 0, no errors.
- Prisma queries use `select` only (membership + team); no `credential.key` anywhere near this surface.
- Error mapping: service throws `ErrorWithCode`, converted by existing `errorConversionMiddleware`; handlers contain no business logic.

## UI
- No UI touched → no screenshots. Gauntlet-loop pass scheduled at Step 3.1.

## Next
- Phase 2 Step 2.1: `page.tsx` route + skeleton/loading/error states.
