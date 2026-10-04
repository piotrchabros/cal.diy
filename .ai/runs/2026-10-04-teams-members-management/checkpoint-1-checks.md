# Checkpoint 1 — Phase 1 (API) complete

**Date:** 2026-10-04T16:00:00Z
**Commits:** b3843d2 (1.1 service), d37b3aa (1.2 queries), c965816 (1.3 mutations)
**PR:** #9 (draft, lock held)

## Targeted validation
- `npx tsc --noEmit -p packages/trpc/tsconfig.server.json` → 0 errors (one
  intermediate `UserRepository` constructor arity error found and fixed in Step 1.2).
- `TZ=UTC yarn test packages/features/membership/services/TeamMembersService.test.ts
  packages/trpc/server/routers/viewer/teams/teamsMutations.handler.test.ts`
  → 2 files, 16/16 tests pass.
- Pre-commit `biome lint` (lint-staged) passes on every Step commit; one
  `useNodejsImportProtocol` error caught and fixed (`node:crypto`).

## Scope check
- All Prisma access uses `select` (no `include` on user-facing reads; no `credential.key`
  anywhere near member selects — member user select is id/name/email/avatarUrl/username/lastActiveAt).
- Business logic in `TeamMembersService` (`ErrorWithCode`); routers throw only `TRPCError`
  (`get`) or delegate to the service (auto-converted by `errorConversionMiddleware`).
- No UI touched → no screenshots this checkpoint (nothing renderable yet).
- No schema changes; no new dependencies.

## Risks / notes
- `UserRepository` constructor requires explicit `prisma` arg (no default) — service passes it.
- Token-accept-on-signup for brand-new emails is a follow-up issue (token + email done;
  signup wiring absent repo-wide).
