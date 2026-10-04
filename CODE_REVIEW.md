# Code review rules

Repo-specific review rules for Cal.diy (Yarn/Turbo monorepo: Next.js web app, tRPC API, Prisma/Postgres, shared packages). `om-code-review` (and therefore `om-auto-review-pr`) applies this file automatically, in addition to its built-in checklist. Human reviewers use the same bar.

## Review priorities

1. **Correctness** — does the change do what the ticket says, including unhappy paths and empty/loading/error states for UI.
2. **Security** — data scoping, auth boundaries, secrets, injection. This codebase schedules on behalf of users; a scoping bug books meetings for the wrong person.
3. **Contracts** — tRPC procedures, API v2 routes, embed message protocol, Prisma schema, and shared-package exports change only per `BACKWARD_COMPATIBILITY.md`.

## Repo-specific checks

- **Prisma: `select`, never `include`.** Every query must project exactly the fields it needs. `include: { user: true }` over-fetches by default — blocker.
- **Never expose `credential.key`.** No query, `select`, API response, log line, or error message may carry the credential key material — blocker, even when tests pass.
- **Error class placement.** Non-tRPC files (services, repositories, utilities) throw `ErrorWithCode`; `TRPCError` appears only in tRPC routers in `packages/trpc/server/routers/`. A `TRPCError` leaking from a service is a major.
- **No business logic in repositories.** Repositories are thin data access; rules and orchestration belong in services. Logic in a repository is a major.
- **Type imports use `import type`.** `import { User } from "@prisma/client"` for a type-only use is a minor; the fix is mechanical.
- **Direct source imports, no barrels.** Import from `@calcom/ui/components/button`, never `@calcom/ui`; never from an `index.ts` barrel. Barrels degrade build granularity — minor, fix before merge.
- **API v2 imports go through platform libraries.** Code in `apps/api/v2` must not import `@calcom/features` or `@calcom/trpc` directly (its tsconfig has no path mappings); re-export from `packages/platform/libraries/index.ts` and import from `@calcom/platform-libraries` — major, it breaks the v2 build.
- **Permission checks live in `page.tsx`, never `layout.tsx`.** A check in a layout is a major (wrong boundary, cached in surprising ways).
- **UI strings are translated.** Every user-facing string ships with a key in `packages/i18n/locales/en/common.json` — missing key is a major for user-facing changes.
- **Dates: `date-fns` or native `Date`.** Day.js is legacy here; new code reaching for Day.js where timezone awareness is not needed is a minor.
- **Never `as any`.** Find the type-safe shape (narrow, guard, or extend the type). A new `as any` is a major.
- **Never edit generated files.** `*.generated.ts` (app-store-cli output) and Prisma client output are build artifacts; edits belong in the generator input — blocker if hand-edited.
- **Early returns over nesting.** Deeply nested conditionals the author could flatten are a minor.
- **Comments explain why, not what.** A comment restating the next line is a nit; a missing why on surprising logic is a minor.
- **PR hygiene.** Title follows conventional commits (`feat:`, `fix:`, `refactor:`); diff stays small and focused (<500 lines, <10 code files); PRs open as drafts until ready. Oversize scope is a major — ask for a split per `AGENTS.md`.

## Validation and severity

- The validation gate is `yarn type-check:ci --force`, then `yarn lint`, then `TZ=UTC yarn test`. Type errors are fixed before test failures are diagnosed — they are usually the root cause. After schema changes, `yarn prisma generate` runs before anything else.
- Severities: **blocker** (must fix; merge is refused — security, data loss, broken contracts, failing gate), **major** (should fix in this PR; otherwise a tracked follow-up issue), **minor** (fix opportunistically), **nit** (style, non-blocking).
- A failing required check or conflicted head is reported as a blocker **together with** the full review, never instead of it.
- `risk-high` areas (auth/sessions, data scoping, money, migrations, shared contracts) need the evidence in `SDLC.md`'s risk table; without it the verdict is `changes-requested` unless a maintainer waives it on the PR.
