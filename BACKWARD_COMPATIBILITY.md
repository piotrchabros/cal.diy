# Backward compatibility

What Cal.diy considers a protected contract surface and how changes to one must be handled. Review skills check changes against this file; implementation skills warn whenever a change violates it. When in doubt, the safer reading wins and the maintainer arbitrates.

## Protected surfaces

| Surface | Where it lives | What counts as breaking |
|---|---|---|
| tRPC procedures | `packages/trpc/server/routers/` (`viewer`, `loggedInViewer`, `publicViewer`) | Renaming/removing a procedure, changing input/output shapes, changing auth requirements, altering error codes callers branch on |
| REST API v2 | `apps/api/v2` (NestJS modules) | Removing/renaming endpoints, changing status codes, request/response shapes, pagination, or auth semantics |
| Embed public API | `packages/embeds/embed-core`, `embed-react`, `embed-snippet` | Changing the snippet interface, init options, or the embed↔parent message protocol (`embed-message-protocol.mermaid`, lifecycle diagrams) |
| Platform packages | `packages/platform/{atoms,libraries,enums,types,constants}` | Removing/renaming exports, changing exported types or enum members, changing constant values consumers persist |
| Shared UI package | `packages/ui` | Removing/renaming exported components or props; changing default visual behavior integrators snapshot |
| App-store apps | `packages/app-store/*` (each app's manifest, config schema, `*.generated.ts`) | Changing an app's slug, config keys, OAuth scopes, or webhook expectations; hand-editing `*.generated.ts` instead of regenerating via app-store-cli |
| Webhook payloads | `packages/features/webhooks` | Renaming/removing event types or payload fields, changing delivery semantics or signing |
| Database schema | `packages/prisma/schema.prisma` + migrations | Any migration that loses or corrupts existing data, non-nullable column without backfill, dropped table/column still read by a supported version, enum value removal |
| i18n keys | `packages/i18n/locales/en/common.json` | Removing or renaming a key still referenced by shipped UI (leaves untranslated strings); changing interpolation placeholders |
| Env/config format | `.env.example` schemas, app config files | Renaming/removing a variable without fallback, changing accepted values or defaults silently |

## Required path for a breaking change

1. **Deprecate first when a consumer exists.** Keep the old shape working (adapter, alias, or fallback) for at least one release cycle and mark it deprecated in code and docs. Internal-only surfaces with no external consumer may skip the window with a maintainer's explicit sign-off on the PR.
2. **Migrate data safely.** Schema changes ship as Prisma migrations that run up *and* down in a test (`up` migrates, `down` restores); destructive migrations carry a rollback plan in the PR body. Backfill before enforcing `NOT NULL`.
3. **Note it in the PR.** The PR body names the surface, the old vs new shape, affected consumers, and the migration/deprecation plan. `om-code-review` treats a silent contract change as a blocker.
4. **Version and changelog.** Public packages (`@calcom/atoms`, embed bundles, API v2) follow semver: breaking change → major bump + changelog entry via the repo's changeset flow (`yarn changesets-add`).
5. **Exercise the consuming side.** The PR must run the consumer against the new shape: API v2 e2e specs, embed lifecycle tests, or the app that renders the changed component — not just the producer's unit tests.

## Non-breaking by default

Additive changes are safe without the path above: new optional fields, new endpoints/procedures, new enum members (unless exhaustively matched without a default), new optional props, new translation keys. Performance or styling changes that preserve shapes and semantics are non-breaking — but verify with the relevant suite, not by assertion.
