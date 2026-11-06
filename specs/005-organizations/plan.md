# Implementation Plan: Organizations

**Branch**: `005-organizations` (one branch per PR below) | **Date**: 2026-11-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-organizations/spec.md`

## Summary

Instance admins create organizations (name, slug, custom domain, owner). Every user and every top-level team belongs to exactly one organization. One running app serves every organization's domain, for example `cal.bluebee.marketing`, `cal.bespokesoft.pl` and `cal.jellymatch.tech`. On each domain the whole product works only for that organization: sign-in, settings, booking pages, and generated links.

The approach rebuilds on the upstream structures still in the schema: an organization is a `Team` with `isOrganization`; members have a `Profile`, `User.organizationId` and an org `Membership`; teams use `Team.parentId`; moves leave a `TempOrgRedirect`. The proxy resolves the request host to an organization through a new `OrganizationSettings.customDomain` column. One base-URL service replaces the stubbed `getBookerBaseUrl` helpers and the hard-coded `WEBAPP_URL` links. Existing data moves into BlueBee, the default organization, through a repeat-safe data migration. All behaviour change sits behind `ORGANIZATIONS_ENABLED`.

## Technical Context

**Language/Version**: TypeScript (strict), Node 20

**Primary Dependencies**: Next.js 16 (App Router plus `pages/api`), next-auth 4.24.13, tRPC, Prisma, Zod, `@evyweb/ioctopus` DI. No new dependencies.

**Storage**: PostgreSQL (production at `.env`; scratch database for tests)

**Testing**: Vitest (`TZ=UTC`), Playwright on the scratch setup only

**Target Platform**: Linux server, blue/green systemd units behind Caddy (`/root/caldiy-deploy.sh`)

**Project Type**: web application (monorepo: `apps/web`, `packages/*`)

**Performance Goals**: host → org resolution adds no database round-trip on cache hits (60-second in-memory cache); org scoping adds at most one indexed predicate per query

**Constraints**: production database; migrations applied by the owner before the deploy that needs them; PRs under 500 lines and 10 code files; behaviour unchanged while `ORGANIZATIONS_ENABLED` is off

**Scale/Scope**: 3 organizations initially, tens of users. About 223 files reference the fixed app URL, of which about 70 carry user-facing links. About 60 files need isolation and org-management changes. Roughly 37 PRs in total.

## Constitution Check

*GATE: checked before Phase 0 and again after Phase 1.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Vertical slices, acyclic graph | PASS | New slice `packages/features/organizations` (repositories, services, DI, lib). tRPC hooks and UI live in `apps/web/modules/organizations`. `packages/lib` gets only DTOs and a pure host-normalisation helper. |
| II. Repositories, DTOs, DI | PASS | `PrismaOrganizationRepository`; services injected through `moduleLoader`; `OrganizationDto` in `packages/lib/dto`; `select` only. |
| III. Type safety, ≥80% coverage, `ErrorWithCode` | PASS | Each PR ships its tests. |
| IV. Stable public APIs | PASS | API v2 contracts unchanged. Links in payloads change host only (same paths). |
| V. Performance, simplicity | PASS | Cached host lookup; no O(n²); no speculative multi-domain-per-org table. |
| Schema change needs approval | **NEEDS OWNER APPROVAL** | PR 1 (`customDomain`), PR 22 (data migration), PR 23 (`organizationId NOT NULL`). See [data-model.md](./data-model.md). |
| Multi-package change needs approval | **NEEDS OWNER APPROVAL** | Unavoidable: features, trpc, web, app-store, emails. |
| Deleting files needs approval | **NEEDS OWNER APPROVAL** | Dead upstream code: `apps/web/getNextjsOrgRewriteConfig.ts`, `packages/lib/domainManager/organization.ts`, `packages/features/profile/lib/createAProfileForAnExistingUser.ts`. |
| PRs as drafts | DEVIATION (recorded) | The owner's standing instruction is to push and squash-merge into `develop`. Each PR is merged once its checks pass; the feature flag keeps production unchanged. |

Post-design re-check: no new violations.

## Project Structure

### Documentation (this feature)

```text
specs/005-organizations/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── trpc-organizations.md
│   ├── request-organization.md
│   └── infra-owner-checklist.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
packages/prisma/schema.prisma, migrations/                      # PR 1, 22, 23
packages/lib/dto/OrganizationDto.ts
packages/lib/organizations/normalizeHost.ts
packages/features/organizations/
├── repositories/PrismaOrganizationRepository.ts (+ interface, test)
├── services/OrganizationService.ts                            # CRUD, validation
├── services/OrganizationMembershipService.ts                  # User.organizationId + Profile + Membership, roles
├── services/OrganizationMoveService.ts                        # moves + TempOrgRedirect
├── services/OrganizationUrlService.ts                         # base URL of a subject
├── lib/OrganizationDomainResolver.ts                          # host → org, cache
├── lib/getOrgFromRequest.ts
└── di/*.module.ts, *.container.ts, tokens.ts
packages/trpc/server/routers/viewer/admin/organizations/       # instance admin procedures
packages/trpc/server/routers/viewer/organization/              # org member/admin procedures
apps/web/proxy.ts                                              # host resolution
apps/web/modules/organizations/                                # admin + org settings views, hooks, OrgBaseUrlProvider
apps/web/app/(use-page-wrapper)/settings/(admin-layout)/admin/organizations/   # page.tsx (permission check), new, [id]
apps/web/app/(use-page-wrapper)/settings/(settings-layout)/organization/       # org settings pages
```

**Structure Decision**: one new vertical slice, `packages/features/organizations`, plus thin tRPC routers and web modules. Existing slices (membership, teams, profile, bookings, auth, app-store) get targeted edits only.

## Delivery: PRs in merge order

Each PR is under 500 lines and 10 code files and ships its tests. The flag stays off until rollout.

**A. Foundation (no behaviour change)**

1. `feat(prisma)`: `OrganizationSettings.customDomain` + migration. *Owner applies before PR 6 deploys.*
2. `feat(organizations)`: `PrismaOrganizationRepository`, `OrganizationDto`, DI wiring.
3. `feat(organizations)`: `OrganizationService` (create, update, delete, list; slug and domain validation; default-org rules) and `OrganizationMembershipService` (three-row sync, role rules).
4. `feat(admin)`: `viewer.admin.organizations` list, get, create, update, delete.
5. `feat(admin)`: admin Organizations list and create/edit pages, nav entry, i18n. Hidden while the flag is off.

**B. Request organization and links**

6. `feat(organizations)`: `OrganizationDomainResolver`, `getOrgFromRequest`, proxy headers and the unknown-host 404; delete the dead subdomain rewrite config. *Needs the file-deletion approval.*
7. `feat(organizations)`: `OrganizationUrlService`; replace the 7 `getBookerBaseUrl` stubs and the CRM `bookerUrl`.
8. `feat(web)`: `OrgBaseUrlProvider` in the root layout; `useBookerUrl`, `useEmbedBookerUrl`, `EmbedCodes`.
9. `feat(auth)`: multi-host next-auth (redirect callback, `getSafeRedirectUrl`, `signIn` org check, magic link origin, JWT `org.fullDomain`, login view).
10. `feat(bookings)`: user pages `[user]` and `[user]/[type]` resolve within the host org; rewrite `handleOrgRedirect`.
11. `feat(teams)`: team pages and `/d/` links within the host org; `TeamProfileService` adds `parentId`.
12. `feat(bookings)`: host check on booking, reschedule and cancel pages; `loadUsers`, `RegularBookingService`, slots.
13–15. `fix(links)`: server link sweep: emails, then workflows/SMS/reminders, then tRPC/webhooks/API (subject-based base URL).
16.1–16.7. `fix(links)`: client link sweep, about 65 files, about 7 PRs grouped by module.
17. `feat(app-store)`: `getOAuthRedirectUri` plus Google Calendar, Office 365 and Zoom.
18.1–18.3. `feat(app-store)`: remaining OAuth apps (mechanical).

**C. Isolation**

19. `feat(teams)`: `teams.create` / `isSlugAvailable` / `inviteMember` scoped to the org; teams list hides the org team.
20. `feat(auth)`: username checks per org; signup and invite assign the org.
21. `feat(event-types)`: org assertion in host assignment; isolation tests across hosts, availability, OOO, notetaker sharing and webhooks.

**D. Switch-over**

22. `feat(prisma)`: BlueBee switch-over data migration (repeat-safe, prints counts). *Owner reviews and applies.*
23. `feat(prisma)`: `User.organizationId NOT NULL`, `onDelete: Restrict`. *Applied after rollout is verified.*

**E. Org self-management**

24. `feat(organizations)`: `viewer.organization` router; `viewer.teams.*` permission checks accept org admins.
25. `feat(organizations)`: Organization settings pages (members, invite, roles, teams).

**F. Moves**

26. `feat(organizations)`: `OrganizationMoveService` plus `moveUser`, `previewMoveTeam`, `moveTeam`, with redirects.
27. `feat(admin)`: move user and move team UI in the admin area.

**Rollout**: [quickstart.md §5](./quickstart.md) and [contracts/infra-owner-checklist.md](./contracts/infra-owner-checklist.md). BespokeSoft and JellyMatch go live after PRs 1–27, the migrations, DNS/Caddy and OAuth registrations, and the moves.

## Risks

| Risk | Mitigation |
|------|------------|
| A missed `WEBAPP_URL` link sends people to the wrong domain | Sweep PRs are grouped by area with grep-based checklists in tasks.md. On BlueBee the fallback is still correct. Quickstart S8 checks every email type. |
| Spoofed `x-cal-org-*` headers | The proxy deletes them first. `getOrgFromRequest` re-resolves from `Host` outside the proxy. |
| The deploy health check refused as an unknown host | Loopback resolves to the default org (quickstart S10). |
| App OAuth breaks for new domains until providers are registered | Owner checklist. Existing connections are unaffected. |
| Data migration on live production | Repeat-safe, printed counts, rehearsed on a copy first. `NOT NULL` comes only after verification. |
| Cross-org leak through a missed query | Isolation tests per touchpoint (PR 21) plus the PR 19/20 service checks. Teams are org-bound, so membership-based checks inherit the boundary. |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Change spans features, trpc, web, app-store, emails | One app serving several domains touches every link builder | Separate app instances per org would triple runtime cost and break instance-wide admin |
| About 37 PRs | Constitution limits PRs to 10 files; about 150 files change | Larger PRs violate the size rule |
