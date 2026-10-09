# Cal.diy Constitution

## Core Principles

### I. Vertical Slices with an Acyclic Dependency Graph

- Code MUST be organized by domain: each folder in `packages/features` is a self-contained
  vertical slice (services, repositories, DTOs, tests).
- The package dependency graph MUST stay acyclic and follow this order, lowest to highest:
  `packages/lib` → `packages/app-store` → `packages/features` → `packages/trpc` → `apps/web`.
  A package MUST NOT import from any package above it.
- `packages/features` MUST stay framework-agnostic and MUST NOT import from `@calcom/trpc` or
  `apps/web`. Code that uses tRPC (hooks, tRPC-dependent components) MUST live in
  `apps/web/modules`.
- Cross-feature imports MUST go through the feature's public API, never its internals.
- Imports MUST target source files directly; barrel (`index.ts`) imports are prohibited.
- `apps/api/v2` MUST consume `@calcom/features` and `@calcom/trpc` code only through
  `@calcom/platform-libraries`.

Rationale: circular and upward dependencies cause build failures and make features impossible
to reason about, test, or reuse from other apps in isolation.

### II. Data Access Behind Repositories and DTOs

- All database access MUST go through Repository classes; repositories are the only code that
  knows about Prisma. Services, tRPC handlers, and app code MUST NOT call Prisma directly.
- Repositories MUST contain data access only. Business logic, validation, and orchestration
  MUST live in Services.
- Prisma queries MUST use `select` with the specific fields required; `include` is permitted
  only when every field of the relation is genuinely needed.
- Database types MUST NOT cross architectural boundaries. Data leaving the data layer MUST be
  mapped to explicit DTOs in `packages/lib/dto/` and validated with Zod.
- Services and repositories MUST receive dependencies through constructor injection wired by
  the DI `moduleLoader` pattern; static-method classes and manual `new` instantiation of
  injectable classes are prohibited.
- Repository methods MUST be named generically (`findById`, `findByIdIncludeHosts`), without
  the entity name and without use-case-specific suffixes.

Rationale: isolating the ORM keeps a technology change confined to repository implementations
and prevents accidental exposure of sensitive columns.

### III. Type Safety and Tested Code (NON-NEGOTIABLE)

- `as any` MUST NOT be used; type mismatches MUST be resolved with a type-safe solution.
- Type-only imports MUST use `import type`.
- `yarn type-check:ci --force` MUST pass before any push, and type errors MUST be fixed before
  test failures are investigated.
- New and modified code MUST have at least 80% test coverage; unit-level logic targets near
  100%.
- Tests MUST run with `TZ=UTC`.
- Errors MUST carry descriptive context. Non-tRPC code (services, repositories, utilities)
  MUST throw `ErrorWithCode`; `TRPCError` is permitted only inside tRPC routers.
- `*.generated.ts` files MUST NOT be edited by hand; change the generator in
  `packages/app-store-cli` instead.

Rationale: the product is scheduling infrastructure that must almost never fail; the compiler
and the test suite are the cheapest places to catch a defect.

### IV. Stable Public APIs

- A published API endpoint MUST NOT change in a backward-incompatible way. Fields MUST NOT be
  renamed or removed, and new fields MUST be optional.
- A behavior change that cannot be made compatibly MUST ship as a new date-versioned endpoint
  in API v2, with the previous version kept functional for at least 6 months.
- Changes to `docs/api-reference/v2/openapi.json` MUST come from generation, not manual edits,
  and endpoint `summary` fields MUST be concise with no trailing period.

Rationale: integrators build on these contracts; a broken contract destroys trust and cannot
be repaired by a later fix.

### V. Enterprise-Scale Performance and Simplicity

- Backend logic MUST NOT introduce O(n²) behavior over collections that grow with users,
  bookings, or time slots. Use sorting with early exit, binary search, or hash-based lookups;
  the target is O(n) or O(n log n).
- Day.js MUST NOT be used in hot loops or for simple date arithmetic. Use native `Date` or
  `date-fns`; reserve Day.js for cases that require timezone awareness, and prefer
  `dayjs.utc()` there.
- Scheduling computations MUST bound their work (timeouts, caching, chunking) rather than
  assume small inputs.
- Code MUST favor clarity over cleverness and MUST solve the problem at hand, not speculative
  future use cases. Added complexity MUST be justified in the PR description.
- Conditionals that select between behaviors MUST be resolved at entry points (factories,
  controllers), keeping each service focused on one responsibility.

Rationale: what works for 10 users collapses at 10,000; performance and readability are
designed in from the start because they cannot be retrofitted cheaply.

## Security and Technology Constraints

**Security**

- `credential.key` MUST NOT appear in any query result, tRPC response, or API response.
- Secrets, API keys, and `.env` files MUST NOT be committed.
- Permission checks MUST be placed in `page.tsx`, never in `layout.tsx`.

**Technology stack**

- Yarn/Turbo monorepo; TypeScript in strict mode; Next.js (App Router); PostgreSQL via Prisma;
  tRPC; NextAuth.js; Tailwind CSS; Vitest for unit tests and Playwright for E2E; Biome for
  formatting and linting.
- Async work MUST follow the Trigger.dev Tasker pattern: `schemaTask` with a Zod payload
  schema, explicit queue/retry/machine config including `outOfMemory` handling, and dynamic
  imports inside `run`.
- Every user-facing string MUST be localized with `t()` and added to
  `packages/i18n/locales/en/common.json`.
- Feature flags MUST be seeded through a Prisma migration.

**Changes requiring explicit approval before work starts**

- Adding a dependency.
- Modifying `packages/prisma/schema.prisma`.
- Changes spanning multiple packages.
- Deleting files.
- Running a full build or the E2E suite.

## Development Workflow and Quality Gates

**Before pushing**

1. `yarn type-check:ci --force` passes.
2. `yarn biome check --write .` has been run.
3. Relevant tests pass under `TZ=UTC`.

**Pull requests**

- Titles and commits MUST follow Conventional Commits (`feat:`, `fix:`, `refactor:`) and be
  specific.
- PRs MUST be opened as drafts.
- A PR MUST stay under 500 changed lines and 10 code files (docs, lock files, and generated
  files excluded) and MUST have a single responsibility. Larger work MUST be split by layer,
  feature component, or dependency order.
- Force pushing or rebasing shared branches is prohibited.

**Review**

- Reviewers MUST request changes for any standards violation, including nits; issues are fixed
  before merge, not in a promised follow-up PR. Follow-ups are acceptable only for changes
  substantial enough to warrant their own PR.
- Reviewers MUST check for `include` in Prisma queries, `credential.key` exposure, unlocalized
  strings, O(n²) logic, circular references, and Day.js in hot paths.
- A CI failure MUST NOT be dismissed as unrelated until the type check has been run locally.
  E2E tests skipped for lack of the `ready-for-e2e` label are expected and need no fix.

**Comments**

- Code comments MUST explain why, not what; comments that restate the code are prohibited.

## Governance

- This constitution supersedes conflicting practices. Where it and another document disagree,
  the constitution governs and the other document MUST be corrected.
- **Amendments** are proposed as a PR that modifies `.specify/memory/constitution.md`, states
  the motivation, and describes any migration needed for existing code. An amendment takes
  effect when a maintainer approves and merges that PR.
- **Versioning** follows semantic versioning: MAJOR for removing or redefining a principle in a
  backward-incompatible way; MINOR for a new principle or section, or materially expanded
  guidance; PATCH for clarifications and wording fixes.
- **Compliance** is verified in every PR review and by CI. Specs, plans, and task lists
  produced through the Spec Kit workflow MUST be checked against these principles, and any
  deviation MUST be recorded with its justification in the plan.
- Day-to-day development guidance lives in `CLAUDE.md` and `agents/rules/`; those files
  elaborate on this constitution and MUST remain consistent with it.

**Version**: 1.0.0 | **Ratified**: 2026-10-08 | **Last Amended**: 2026-10-08
