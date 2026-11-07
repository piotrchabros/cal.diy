---

description: "Task list for Organizations (spec 005)"
---

# Tasks: Organizations

**Input**: `specs/005-organizations/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: required. Constitution III demands at least 80% coverage of new and changed code. Every task that adds or changes logic ships its Vitest file next to the source, run with `TZ=UTC`. Database-writing tests run only against the scratch database.

**PR mapping**: `(PR n)` refers to the merge-order list in plan.md. One PR stays under 500 lines and 10 code files.

**Conventions for every task**:
- `select` only, no `include`.
- `import type` for types.
- `ErrorWithCode` outside tRPC routers.
- DTOs from `packages/lib/dto/OrganizationDto.ts`.
- DI through `bindModuleToClassOnToken` + `*.container.ts`, following `packages/features/notetaker/di/`.
- Every UI string goes in `packages/i18n/locales/en/common.json`.
- Behaviour unchanged while `ORGANIZATIONS_ENABLED` is unset.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Create the slice folders `packages/features/organizations/{repositories,services,lib,di}` and `apps/web/modules/organizations/{views,components,hooks}`. Add `ORGANIZATIONS_DI_TOKENS` in `packages/features/organizations/di/tokens.ts` and spread it into `packages/features/di/tokens.ts` (PR 2)
- [X] T002 [P] Add the `isOrganizationsEnabled()` helper, reading `process.env.ORGANIZATIONS_ENABLED === "1" || === "true"`, in `packages/lib/organizations/isOrganizationsEnabled.ts` with a test (PR 2)
- [X] T003 [P] Add `normalizeHost(host: string | null): string | null` (lowercase, strip port, strip trailing dot; `null` for empty input) and `isLoopbackHost(host)` (`localhost`, `127.0.0.1`, `::1`, `[::1]`) in `packages/lib/organizations/normalizeHost.ts` with a test (PR 2)

---

## Phase 2: Foundational (blocks every story)

**Schema (PR 1)**

- [X] T004 Add `customDomain String? @unique` to `model OrganizationSettings` in `packages/prisma/schema.prisma`, with the doc comment `/// Lowercase host name without scheme or port, e.g. "cal.bespokesoft.pl"` (data-model.md Change 1)
- [X] T005 Create the migration `packages/prisma/migrations/20261107000000_add_organization_custom_domain/migration.sql`: `ALTER TABLE "OrganizationSettings" ADD COLUMN "customDomain" TEXT;` plus `CREATE UNIQUE INDEX "OrganizationSettings_customDomain_key" ON "OrganizationSettings"("customDomain");`. Run `yarn prisma generate`. Do NOT apply it to the `.env` database; the owner runs `db-deploy`

**Repository and DTOs (PR 2)**

- [X] T006 [P] Define the `OrganizationDto`, `OrganizationListItemDto` and `OrganizationOwnerDto` Zod schemas and types in `packages/lib/dto/OrganizationDto.ts`, with the fields from contracts/trpc-organizations.md: `{ id, name, slug, domain: string | null, isDefault, memberCount, teamCount, owners: { userId, name, email }[] }`
- [X] T007 Define `IOrganizationRepository` in `packages/features/organizations/repositories/interfaces/IOrganizationRepository.ts`. Methods:
  - `findById`
  - `findBySlug`
  - `findByDomain`
  - `findDefault(domain)`
  - `list({ search, cursor, limit })`
  - `create({ name, slug, domain })`, which creates the `Team` (`isOrganization: true`, `parentId: null`) and the `OrganizationSettings` with `isOrganizationConfigured: true`, `isOrganizationVerified: true`
  - `update`
  - `delete`
  - `countMembers`
  - `countTeams`
  - `findOwners`
- [X] T008 Implement `PrismaOrganizationRepository` in `packages/features/organizations/repositories/PrismaOrganizationRepository.ts`. All reads filter `isOrganization: true, parentId: null`, and `findByDomain` matches `organizationSettings.customDomain`. Add a unit test with a mocked Prisma client and the module `packages/features/organizations/di/PrismaOrganizationRepository.module.ts`

**Services (PR 3)**

- [X] T009 Implement `OrganizationService` in `packages/features/organizations/services/OrganizationService.ts` with `list`, `get`, `create`, `update` and `delete`. Validation rules:
  - The slug matches `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`, is "at least 2 characters", and is unique among organizations, checked in the service because the index does not cover `parentId IS NULL`.
  - The domain is a valid FQDN, is normalised with `normalizeHost`, and is unique.
  - `isDefault` is `domain === normalizeHost(new URL(WEBAPP_URL).host)`.
  - `delete` is refused with `ErrorWithCode(PreconditionFailed)` when the org has members or teams, or is the default.

  Add the test `OrganizationService.test.ts`
- [X] T010 Implement `OrganizationMembershipService` in `packages/features/organizations/services/OrganizationMembershipService.ts`:
  - `addMember({ organizationId, userId, role })` writes, in one transaction, `User.organizationId`, a `Profile` (`uid`, `username = users.username`) and an accepted org `Membership`.
  - `setRole` follows the data-model.md role rules: "ADMIN can grant MEMBER and ADMIN; only an OWNER can grant or remove OWNER; the last OWNER cannot be demoted or removed".
  - `getRole(userId, organizationId)`.

  Add a test covering the last-owner and role rules
- [X] T011 Add DI modules and containers in `packages/features/organizations/di/`: `OrganizationService.module.ts`, `OrganizationService.container.ts` (`getOrganizationService()`), `OrganizationMembershipService.module.ts`, `OrganizationMembershipService.container.ts` (`getOrganizationMembershipService()`)

**Request organization (PR 6)**

- [X] T012 Implement `OrganizationDomainResolver.resolve(host)` in `packages/features/organizations/lib/OrganizationDomainResolver.ts`:
  - When the flag is off or the host is loopback, it returns the default org.
  - Otherwise it looks up `findByDomain` with a 60-second in-memory TTL cache, and returns `null` for an unknown host.

  Add a test covering the cache, loopback, flag off and unknown host
- [X] T013 Implement `getOrgFromRequest(headers: Headers)` in `packages/features/organizations/lib/getOrgFromRequest.ts`. It reads the trusted `x-cal-org-id` / `x-cal-org-slug` headers and falls back to `OrganizationDomainResolver.resolve(headers.get("host"))`. Add a test
- [X] T014 Update `apps/web/proxy.ts`:
  - Widen the matcher to every route except `/_next/*` and static assets.
  - Delete the incoming `x-cal-org-id` / `x-cal-org-slug` headers.
  - Resolve the host and set the headers through `NextResponse.next({ request: { headers } })`.
  - Return a plain `404` for an unknown host (contracts/request-organization.md).

  Keep the existing embed, CSP and signup logic. Extend `apps/web/proxy.test.ts` or create it
- [X] T015 Delete the dead upstream subdomain rewrites: `apps/web/getNextjsOrgRewriteConfig.ts`, the `isOrganizationsEnabled` / `orgDomainMatcherConfig` blocks and the `X-Cal-Org-path` headers in `apps/web/next.config.ts`, and the `orgUserRoutePath` regexes in `apps/web/pagesAndRewritePaths.ts` if unused afterwards. Also delete `packages/lib/domainManager/organization.ts` (owner-approved deletions)

**Base URL (PR 7)**

- [X] T016 Implement `OrganizationUrlService` in `packages/features/organizations/services/OrganizationUrlService.ts` with `getBaseUrl({ organizationId })`, `getBaseUrlForUser({ userId })` and `getBaseUrlForTeam({ teamId })` (the team's parent org). It returns `https://<customDomain>` and falls back to `WEBAPP_URL` when there is no domain or the flag is off. Add a test, DI module and container
- [X] T017 Replace the stubbed `getBookerBaseUrl` / `getBookerBaseUrlSync` copies with calls to `OrganizationUrlService` in:
  - `packages/features/CalendarEventBuilder.ts`
  - `packages/features/eventtypes/lib/getEventTypesByViewer.ts`
  - `packages/features/eventtypes/lib/getPublicEvent.ts`
  - `packages/features/eventtypes/lib/getEventTypeById.ts`
  - `packages/features/bookings/lib/payment/getBooking.ts`
  - `packages/trpc/server/routers/viewer/eventTypes/utils/transformUtils.ts`
  - `packages/platform/libraries/organizations.ts`

  Also set `bookerUrl` from the organizer's org in `packages/features/tasker/tasks/crm/lib/buildCalendarEvent.ts`. Update the affected tests

**Client base URL (PR 8)**

- [X] T018 Create `OrgBaseUrlProvider` and `useOrgBaseUrl()` in `apps/web/modules/organizations/components/OrgBaseUrlProvider.tsx`. Mount it in the root layout `apps/web/app/layout.tsx` with `baseUrl` computed server-side from `getOrgFromRequest(headers())` + `OrganizationUrlService`. Add a test
- [X] T019 Make `useBookerUrl` and `useEmbedBookerUrl` in `packages/features/bookings/hooks/useBookerUrl.ts` return the context value. The hook must not import from `apps/web`: pass the value through a context defined in `packages/features/organizations/lib/OrgBaseUrlContext.ts` that the web provider fills. Make `packages/features/embed/lib/EmbedCodes.tsx` always emit `calOrigin` as the booker URL. Add tests

**Auth (PR 9)**

- [X] T020 In `packages/features/auth/lib/next-auth-options.ts`:
  - The `redirect` callback (~line 1164) allows the hosts of `WEBAPP_URL`, `WEBSITE_URL` and every org `customDomain`.
  - The `signIn` callback refuses with error `wrong_organization_domain` when the flag is on and `user.organizationId !== host org id`.
  - The JWT `org.fullDomain` (~line 521) comes from `OrganizationUrlService`.

  Add tests
- [X] T021 [P] Make `packages/lib/getSafeRedirectUrl.ts` accept org domains through an injected allow-list argument (`packages/lib` must not import features), with the callers passing the org domains. Stop rewriting magic links to `NEXTAUTH_URL` in `packages/features/auth/lib/sendVerificationRequest.ts:21`. Add tests
- [X] T022 [P] In the next-auth `signIn` callback, run the domain policy after authentication (credentials + 2FA, OAuth, magic-link callback; not the magic-link request step). A user from another organization is redirected to `https://<user's org domain>/auth/login?reason=wrong_organization_domain`; a redirect that would loop goes to `/auth/error?error=wrong_organization_domain`. In `apps/web/modules/auth/login-view.tsx`: build the callback from the request organization's base URL (`useOrgBaseUrl`) instead of `WEBAPP_URL`, follow the organization login redirect returned by `signIn`, show the `wrong_organization_domain` error and the `?reason=` notice. Add the error branch to the `/auth/error` page. No email→domain lookup endpoint, so emails can't be enumerated. Also update `apps/web/server/lib/auth/login/getServerSideProps.tsx` JWT issuer/audience. Add tests

**Checkpoint**: the foundation is merged; with the flag off nothing changes for users (quickstart S13).

---

## Phase 3: User Story 1 – An instance admin creates an organization (P1) 🎯 MVP

**Goal**: list, create, edit and delete organizations in the admin area.
**Independent test**: quickstart S2, S3 and S12.

**PR 4: router**

- [X] T023 [US1] Create the `viewer.admin.organizations` router in `packages/trpc/server/routers/viewer/admin/organizations/_router.ts` with `list`, `get`, `create`, `update` and `delete` on `authedAdminProcedure`. Use the Zod inputs from contracts/trpc-organizations.md, including `owner: { userId } | { email }` and `confirmMoveOwner`. Each handler is a thin call to `getOrganizationService()`. Register it in `packages/trpc/server/routers/viewer/admin/_router.ts`
- [ ] T024 [US1] (userId owners, rollback and audit log done in PR 4; the email-owner invitation and `update.ownerUserId` follow in PR 4b) Implement owner assignment in `OrganizationService.create`:
  - An existing user is added through `OrganizationMembershipService.addMember(role OWNER)`.
  - If the user is in another org and `confirmMoveOwner` is not set, return `PreconditionFailed`. With confirmation, use the move from T067, or until T067 lands refuse with a clear error.
  - An unknown email creates a `VerificationToken` for the org team and sends `TeamInviteEmail` with the link on the org's base URL.
  - Log `action: "organization.create"` with ids only (FR-023).

  Update `OrganizationService.test.ts`
- [X] T025 [P] [US1] Add router tests in `packages/trpc/server/routers/viewer/admin/organizations/_router.test.ts`: a non-admin is refused, inputs are validated, and errors are mapped

**PR 5: UI**

- [X] T026 [US1] Create `apps/web/app/(use-page-wrapper)/settings/(admin-layout)/admin/organizations/page.tsx` (list), `.../organizations/new/page.tsx` and `.../organizations/[id]/edit/page.tsx`. The permission check (`role === "ADMIN"`) and the `isOrganizationsEnabled()` check go in each `page.tsx`, returning `notFound()` when the flag is off
- [X] T027 [US1] Create the views `apps/web/modules/organizations/views/organizations-listing-view.tsx` (columns: name, slug, domain, members, teams, default badge) and `organization-form-view.tsx` (name, slug, domain, owner picker by user search or email). Show the confirm dialog for the PRECONDITION_FAILED owner move, the domain-change warning (US1-5), and delete with error display
- [X] T028 [P] [US1] Add the "Organizations" admin nav entry in `apps/web/app/(use-page-wrapper)/settings/(settings-layout)/SettingsLayoutAppDirClient.tsx`, shown only when the flag is on. Add all strings to `packages/i18n/locales/en/common.json`
- [X] T029 [P] [US1] Add view tests in `apps/web/modules/organizations/views/organizations-listing-view.test.tsx` and `organization-form-view.test.tsx`

**Checkpoint**: US1 works on scratch (S2, S3, S12).

---

## Phase 4: User Story 2 – Users and teams stay inside their organization (P1)

**Goal**: no non-admin action crosses organizations.
**Independent test**: quickstart S6 and S7, plus the isolation tests.

**PR 19**

- [X] T030 [US2] In `packages/features/membership/services/TeamCreationService.ts`, set `parentId = caller.organizationId` on create, and scope the slug check (lines ~47-54) and `isSlugAvailable` to `parentId = caller org`. Update the tests
- [X] T031 [US2] In `packages/features/membership/services/TeamMembersService.ts` `inviteMember` (~line 155):
  - Look up the invitee within the team's parent org (add `UserRepository.findByEmailAndOrganizationId`).
  - Refuse with `ErrorWithCode(Conflict, "user_belongs_to_another_organization")` when the email exists in another org.
  - Create new invitees in the team's org through `OrganizationMembershipService.addMember` (replacing `organizationId: null` in `createInvitedWithPendingTeamMembership`, ~line 159).

  Update the tests
- [X] T032 [P] [US2] In `apps/web/app/(use-page-wrapper)/(main-nav)/teams/page.tsx` (~line 21), exclude memberships whose team has `isOrganization: true`, and make the admin users and teams lists show the organization column and filter (contracts: "organization: { id, name } column and an organizationId filter"). Files: `packages/trpc/server/routers/viewer/admin/listPaginated.handler.ts`, `apps/web/modules/users/components/UsersTable.tsx`

**PR 20**

- [X] T033 [US2] Scope username checks to the subject's org:
  - `packages/features/profile/lib/checkRegularUsername.ts`
  - `packages/lib/server/username.ts` (always pass `orgId`)
  - `packages/features/auth/signup/username.ts`
  - `apps/web/app/api/username/route.ts`: the org comes from `getOrgFromRequest`, not the body; remove the `isValidOrgDomain = false` stub

  Update the tests
- [ ] T034 [US2] (handler, `createOrUpdateMemberships` and org-scoped username validation done; `completeInviteSignup` postponed, see below) Signup in `apps/web/app/api/auth/signup/handlers/selfHostedHandler.ts`:
  - Without a token (~line 169), the user joins the host org (`getOrgFromRequest`), which on the default domain is the default org (FR-013).
  - With a token, the user joins the token team's parent org.
  - The membership is written through `OrganizationMembershipService.addMember`.

  Also update `packages/features/auth/signup/utils/createOrUpdateMemberships.ts` and `TeamMembersService.completeInviteSignup`. Add tests
  - POSTPONED: `TeamMembersService.completeInviteSignup` cannot write the org membership through `addMember`: invitees created by `inviteMember` (T031) have `username = null`, the invite-completion flow only sets a password, and `addMember` needs a username for the org `Profile`. Open question: how does such an invitee get their org username? Options: (a) derive it from the email (`getOrgUsernameFromEmail`, the upstream convention) and make it unique in the org; (b) add a username field to the invite-completion form; (c) create the org profile and membership when the user first sets a username (onboarding / `updateProfile`, together with T130).
- [X] T035 [P] [US2] Make `userAdminRouter.add` in `packages/trpc/server/routers/viewer/users/_router.ts` require an `organizationId` (defaulting to the default org) and use `OrganizationMembershipService.addMember`. Add tests

**PR 21**

- [X] T036 [US2] Add the assertion "every host's user is in the event type's team org" to `packages/features/host/services/EventTypeHostService.ts` for host assignment, and refuse otherwise. Add tests
- [X] T037 [P] [US2] Add the cross-org isolation test suite `packages/features/organizations/tests/isolation.test.ts`. Use in-memory fakes with two orgs, each with users and a team, and assert NOT_FOUND or exclusion for:
  - `teams.get` / `listMembers` / `inviteMember`
  - `eventTypes.searchTeamMembers` / `getHostsForAssignment`
  - `availability.listTeam`
  - OOO `toTeamUserId`
  - notetaker `listEventTypeSharingCandidates`
  - webhook team create

**Checkpoint**: S6 and S7 pass; the isolation suite is green.

---

## Phase 5: User Story 3 – Each organization is served on its own domain (P1)

**Goal**: pages, sign-in and links follow the organization's domain.
**Independent test**: quickstart S4 (link part), S5, S8, S9 and S10.

**PR 10: user pages**

- [X] T038 [US3] In `apps/web/server/lib/[user]/getServerSideProps.ts` (~79-100), replace the `currentOrgDomain = null; isValidOrgDomain = false` stub with `getOrgFromRequest(context.req.headers)` and pass its slug to `getUsersInOrgContext` / `UserRepository.findUsersByUsername({ orgSlug })`. Add a test
- [X] T039 [US3] Make the same change in `apps/web/server/lib/[user]/[type]/getServerSideProps.ts` (~127-146, ~226-249), passing `org` to `getPublicEvent`. Add a test
- [X] T040 [US3] Rewrite `apps/web/lib/handleOrgRedirect.ts`:
  - Look up `TempOrgRedirect` with `fromOrgId = host org id` and `enabled = true`.
  - Return `{ redirect: { destination: toUrl + rest of path + query, permanent: true } }`.
  - Remove the `orgRedirection=true` guard.

  Update `handleOrgRedirect.test.ts`

**PR 11: team pages and /d/**

- [X] T041 [US3] In `packages/features/teams/services/TeamProfileService.ts` `getPublicTeamBySlug` (~211-216), add a `parentId: <host org id>` parameter and filter. Update `apps/web/app/(booking-page-wrapper)/team/[slug]/page.tsx` to pass the host org and call `handleOrgRedirect` with type `Team`. Add tests
- [X] T042 [US3] In `apps/web/server/lib/team/[slug]/[type]/getServerSideProps.ts` (~41,57), pass the host org instead of `org: null` and add redirect handling. Add a test
- [X] T043 [US3] In `apps/web/lib/d/[link]/[slug]/getServerSideProps.tsx` (~26-28), remove the stub and return 404 when the hashed link's owner or team is not in the host org. Add a test

**PR 12: bookings**

- [X] T044 [US3] In `apps/web/modules/bookings/views/bookings-single-view.getServerSideProps.tsx` (~215-247) and `apps/web/lib/reschedule/[uid]/getServerSideProps.ts`, when the organizer's org differs from the host org, redirect (308) to the same path on the organizer's org base URL. Add tests
- [X] T045 [US3] In `packages/features/bookings/lib/handleNewBooking/loadUsers.ts`, remove the `getOrgDomainConfig` stub (~line 15) and resolve the org from `hostname`. In `packages/features/bookings/lib/service/RegularBookingService.ts`, refuse with `ErrorWithCode(NotFound, "event_not_found")` when the event type's owner or team org differs from the host org; API v2 calls keep using `forcedSlug`. Add tests
- [X] T046 [P] [US3] In `packages/trpc/server/routers/viewer/slots/util.ts` (~180-192, 346-369), pass the request org instead of the "no org" default. Add a test

**PRs 13–15: server link sweep** (replace `WEBAPP_URL` user-facing links with `OrganizationUrlService` for the subject; leave server-to-server API bases alone)

- [X] T047 [US3] PR 13, emails, links in:
  - `packages/emails/src/templates/{TeamInviteEmail,OrganizerRequestEmail,OrganizerRequestEmailV2,BrokenIntegrationEmail,DisabledAppEmail,DailyVideoDownloadRecordingEmail,DailyVideoDownloadTranscriptEmail,SlugReplacementEmail}.tsx`
  - `packages/emails/templates/organizer-request-email.ts`

  Pass the base URL in through the email's props from the caller. Update the email tests
- [X] T048 [US3] PR 14, auth and SMS:
  - `packages/features/auth/lib/{passwordResetRequest,verifyEmail}.ts`
  - `packages/trpc/server/routers/viewer/admin/sendPasswordReset.handler.ts`
  - `packages/sms/attendee/*.ts` (7 files): use `CalendarEvent.bookerUrl` or the organizer's base URL

  Add tests
- [X] T049 [US3] PR 15, bookings and tRPC:
  - `packages/features/bookings/lib/{buildEventUrlFromBooking,handleCancelBooking}.ts`
  - `packages/features/bookings/lib/service/RegularBookingService.ts` (`bookerUrl`)
  - `packages/trpc/server/routers/viewer/bookings/confirm.handler.ts`
  - `packages/trpc/server/routers/viewer/slots/reserveSlot.handler.ts`
  - `packages/lib/CalEventParser.ts`: the `WEBAPP_URL` fallback stays only when `bookerUrl` is absent

  Add tests

**PRs 16.1–16.7: client link sweep** (replace `WEBAPP_URL` / `WEBSITE_URL` / `NEXT_PUBLIC_WEBAPP_URL` in user-facing links with `useOrgBaseUrl()`, or `window.location.origin` where the current host is by definition right; keep build-time constants for assets and SEO defaults)

- [ ] T050 [P] [US3] PR 16.1, auth:
  - `apps/web/modules/auth/{logout-view,team-invite-view,verify-view}.tsx`
  - `apps/web/modules/auth/hooks/useRedirectToLoginIfUnauthenticated.tsx`
  - `apps/web/modules/signup-view.tsx`
  - `apps/web/components/setup/AdminUser.tsx`
- [ ] T051 [P] [US3] PR 16.2, booking pages:
  - `apps/web/modules/bookings/components/{BookerWebWrapper,event-meta/AvailableEventLocations,event-meta/Members}.tsx`
  - `packages/features/bookings/components/Header.tsx`
  - `apps/web/app/(booking-page-wrapper)/{[user]/page,[user]/[type]/page,booking/[uid]/page,team/[slug]/[type]/page}.tsx`
- [ ] T052 [P] [US3] PR 16.3, event types:
  - `apps/web/modules/event-types/components/{CreateEventTypeDialog,DuplicateDialog,EventTypeWebWrapper,locations/Locations,tabs/setup/EventSetupTabWebWrapper}.tsx`
- [ ] T053 [P] [US3] PR 16.4, settings and teams:
  - `apps/web/modules/settings/my-account/{appearance-view,profile-view}.tsx`
  - `apps/web/modules/settings/teams/team-profile-view.tsx`
  - `apps/web/modules/teams/views/teams-listing-view.tsx`
  - `apps/web/app/(use-page-wrapper)/teams/new/{create-team-view,team-public-preview}.tsx`
  - `apps/web/app/(use-page-wrapper)/(main-nav)/teams/page.tsx`
  - `apps/web/components/ui/UsernameAvailability/{index,PremiumTextfield}.tsx`
- [ ] T054 [P] [US3] PR 16.5, users, shell and webhooks:
  - `apps/web/modules/users/components/{UsersTable,UserTable/UserListTable,UserTable/EditSheet/EditUserSheet}.tsx`
  - `apps/web/modules/shell/{SideBar,navigation/useMobileMoreItems}.tsx`
  - `apps/web/modules/webhooks/{components/WebhookForm,views/webhooks-view}.tsx`
  - `apps/web/app/(use-page-wrapper)/settings/(settings-layout)/SettingsLayoutAppDirClient.tsx`
- [ ] T055 [P] [US3] PR 16.6, apps:
  - `apps/web/components/apps/{AppPage,alby/Setup,btcpayserver/Setup,wipemycalother/confirmDialog}.tsx`
  - `apps/web/components/getting-started/components/AppConnectionItem.tsx`
  - `apps/web/modules/apps/{components/AppCard,installation/[[...step]]/step-view}.tsx`
  - `packages/app-store/_utils/useAddAppMutation.ts`
- [ ] T056 [P] [US3] PR 16.7, the rest:
  - `apps/web/components/PageWrapper.tsx` (canonical URL)
  - `apps/web/modules/{onboarding/components/onboarding-browser-view,connect-and-join/connect-and-join-view,videos/views/videos-single-view,maintenance/maintenance-view}.tsx`
  - `apps/web/app/(use-page-wrapper)/{payment/[uid]/PaymentPage,video/[uid]/page}.tsx`
  - `packages/ui/components/avatar/UserAvatarGroup.tsx`
  - `packages/lib/OgImages.tsx`

  Finish with `rg -n "WEBAPP_URL|WEBSITE_URL|NEXT_PUBLIC_WEBAPP_URL" apps/web/modules apps/web/components` and justify each remaining hit in the PR description

**PRs 17–18: app OAuth**

- [X] T057 [US3] PR 17: create `getOAuthRedirectUri(req, appSlug)` in `packages/app-store/_utils/oauth/getOAuthRedirectUri.ts`. It builds the URL from the request `Host` via `normalizeHost`, refuses unknown hosts, and must not import features: the host is checked against an allow-list passed by the caller or read from `ALLOWED_HOSTNAMES`. Use it in the `api/add.ts` and `api/callback.ts` of `googlecalendar`, `office365calendar`, `office365video` and `zoomvideo`, and let `getSafeRedirectUrl` targets include the org domains. Add tests
- [X] T058 [P] [US3] PR 18.1: `basecamp3`, `closecom`, `feishucalendar`, `hubspot`, `intercom`, `larkcalendar`, `pipedrive-crm`, `salesforce` (`packages/app-store/<app>/api/*` and `lib/*` files referencing `WEBAPP_URL_FOR_OAUTH`)
  - Split for the 10-file PR limit: 18.1a (`basecamp3`, `closecom`, `feishucalendar`, `larkcalendar`) and 18.1b (`hubspot`, `intercom`, `pipedrive-crm`, `salesforce`)
- [X] T059 [P] [US3] PR 18.2: `webex`, `zoho-bigin`, `zohocalendar`, `zohocrm`, `huddle01video`, `tandemvideo`, `nextcloudtalk`, `vital`, `jelly`
  - Split for the 10-file PR limit: 18.2a (`webex`, `zoho-bigin`, `zohocalendar`, `zohocrm`) and 18.2b (`huddle01video`, `tandemvideo`, `nextcloudtalk`, `jelly`). `vital` moved to T060
- [ ] T060 [P] [US3] PR 18.3: payment apps `stripepayment`, `paypal`, `hitpay`, `lyra`, plus `packages/app-store/_utils/paid-apps.ts`

**Checkpoint**: S4 (links), S5, S8, S9 and S10 pass on scratch.

---

## Phase 6: User Story 6 – Existing data moves into BlueBee (P1)

**Goal**: everyone is in an organization, with nothing visibly changing.
**Independent test**: quickstart S1, plus the counts on a copy of production.

- [ ] T061 [US6] PR 22: write the repeat-safe data migration `packages/prisma/migrations/20261107000100_organizations_bluebee_switchover/migration.sql` implementing data-model.md Change 2, steps 1–6:
  - BlueBee `slug = 'bluebee'`, `customDomain = 'cal.bluebee.marketing'`.
  - Use `WHERE NOT EXISTS` / `ON CONFLICT DO NOTHING`.
  - Membership role OWNER "for `users.role = 'ADMIN'`", MEMBER otherwise.
  - Print counts with `RAISE NOTICE` before and after.

  Rehearse it on a scratch copy twice: the second run must change nothing. The owner applies it to production
- [ ] T062 [US6] PR 23 (only after the rollout is verified): change `User.organizationId` to `Int` with `onDelete: Restrict` in `packages/prisma/schema.prisma`, and create a migration that first runs `DO $$ BEGIN IF EXISTS (SELECT 1 FROM users WHERE "organizationId" IS NULL) THEN RAISE EXCEPTION ...` and then `ALTER COLUMN ... SET NOT NULL`. Fix the type errors this causes (`yarn type-check:ci --force`)

---

## Phase 7: User Story 4 – Org owners and admins manage their own organization (P2)

**Goal**: org admins handle members and teams themselves.
**Independent test**: quickstart S11.

**PR 24**

- [X] T063 [US4] Create the `viewer.organization` router in `packages/trpc/server/routers/viewer/organization/_router.ts` with `current`, `listMembers`, `inviteMember`, `updateRole`, `removeMember` and `listTeams`, as in contracts/trpc-organizations.md. The org always comes from `ctx.user.organizationId`. Register it in `packages/trpc/server/routers/viewer/_router.tsx`. Add tests
- [X] T064 [US4] Add `inviteMember`, `removeMember` (a move to the default org, FR-011) and `listTeams` to `OrganizationMembershipService`, with the role rules. Log the actions with ids only. Add tests
- [X] T065 [US4] Extend the `viewer.teams.*` permission checks (`packages/features/membership/services/TeamMembersService.ts`, `TeamProfileService.ts`, delete team) so that "team admin **or** org ADMIN/OWNER of the team's parent org" may act. Add tests

**PR 25**

- [ ] T066 [US4] Create `apps/web/app/(use-page-wrapper)/settings/(settings-layout)/organization/{members,teams}/page.tsx`, with the flag check and membership check in `page.tsx`. Create the views `apps/web/modules/organizations/views/{org-members-view,org-teams-view}.tsx` (read-only for MEMBER), add the nav entry in `SettingsLayoutAppDirClient.tsx`, the i18n strings and view tests

---

## Phase 8: User Story 5 – An instance admin moves users and teams (P2)

**Goal**: populate BespokeSoft and JellyMatch from BlueBee.
**Independent test**: quickstart S4.

**PR 26**

- [ ] T067 [US5] Implement `OrganizationMoveService` in `packages/features/organizations/services/OrganizationMoveService.ts`:
  - `moveUser({ userId, toOrganizationId, newUsername? })` removes the user's memberships of old-org teams, updates `User.organizationId`, the `Profile` and the org `Membership`, writes `TempOrgRedirect { from: oldUsername, fromOrgId: oldOrgId, type: User, toUrl: https://<new domain>/<username>, enabled: true }`, and returns CONFLICT when the username is taken in the target org.
  - `previewMoveTeam` and `moveTeam({ outsideMembers: "move" | "remove", newSlug? })` set `parentId` and write the `Team` redirect.
  - Disable redirects (`enabled = false`) when the old org reuses the `from` username or slug. Hook this into `addMember` and team create/rename.

  Add a full test suite
- [ ] T068 [US5] Add `moveUser`, `previewMoveTeam` and `moveTeam` to `packages/trpc/server/routers/viewer/admin/organizations/_router.ts`, with tests. Wire `confirmMoveOwner` in `OrganizationService.create` to `moveUser`

**PR 27**

- [ ] T069 [US5] Add a "Move to organization" action in the admin user edit view `apps/web/modules/users/views/users-edit-view.tsx` (target org select, plus a username prompt on CONFLICT) and a team move dialog in `apps/web/modules/organizations/views/organization-form-view.tsx` or the admin teams list (preview of outside members, move/remove choice, new slug). Add i18n strings and tests

---

## Phase 9: Polish and cross-cutting

- [ ] T070 [P] Delete `packages/features/profile/lib/createAProfileForAnExistingUser.ts` and `UserRepository.findManyByOrganization` (dead, owner-approved) (with PR 26)
- [ ] T071 [P] Add a Playwright spec `apps/web/playwright/organizations.e2e.ts` for quickstart S2, S4, S5 and S6, run on the scratch setup only and with the owner's go-ahead
- [ ] T072 Document the rollout in `specs/005-organizations/quickstart.md` §5, finalise `contracts/infra-owner-checklist.md` with the actual OAuth apps in use (quickstart step 0), and add `ORGANIZATIONS_ENABLED` / `AUTH_TRUST_HOST` notes to `.env.example`
- [ ] T073 Run the full quickstart S1–S13 on the scratch setup and record the results in the last PR description
- [ ] T074 Create OAuth (Google, Azure AD) sign-ups in the request organization when the flag is on. Today they are created without an organization, so the `signIn` domain policy refuses them. Add tests
- [ ] T075 In `getServerSession` / `ensureSession`, check on each request that the database `user.organizationId` matches the request organization. This defends against a session token copied to another domain. Add tests
- [ ] T076 Owner checklist (`contracts/infra-owner-checklist.md`): set `AUTH_TRUST_HOST` only together with `ORGANIZATIONS_ENABLED`; Caddy must overwrite `X-Forwarded-*` headers; the Node ports must not be reachable from outside
- [ ] T110 [US3] Run the T045 host-organization check (`assertEventTypeInHostOrganization` in `packages/features/organizations/lib/resolveBookingHostOrganization.ts`) for instant meetings and API v1 bookings (`createBookingForApiV1`), which bypass `RegularBookingService.handler`. Add tests
- [ ] T111 [US3] In `packages/trpc/server/routers/viewer/slots/getSchedule.handler.ts`, refuse (NOT_FOUND) a direct `eventTypeId` whose owner/team organization differs from the request organization; T046 only scopes slug lookups. Add tests
- [ ] T112 [P] [US3] Let `apps/api/v2` bookings skip the host-organization check explicitly (instead of relying on its Host not resolving): with a loopback Host the resolver returns the default org and would refuse other organizations' event types. Pass a flag from `packages/platform/libraries` into `RegularBookingService`. Add tests
- [ ] T120 [P] [US2] Add an instance-admin teams list (none exists today) with the `organization: { id, name }` column and `organizationId` filter required by US2-5 / contracts/trpc-organizations.md, e.g. `apps/web/app/(use-page-wrapper)/settings/(admin-layout)/admin/teams/page.tsx` + an admin `teams.listPaginated` procedure (split out of T032)
- [ ] T130 [US2] Keep the org `Profile.username` in sync when an org member changes their username in `packages/trpc/server/routers/viewer/me/updateProfile.handler.ts` (data-model.md: `users.username` equals `Profile.username`; both are written on change). Today only `users.username` is updated. Add tests
- [ ] T131 [US2] In `TeamMembersService.acceptPendingInvitesOnSignup` (`packages/features/membership/services/TeamMembersService.ts`), skip pending invites to teams outside the organization the new user just joined when the flag is on. Add tests
- [ ] T132 [US2] In `apps/web/app/api/auth/signup/handlers/selfHostedHandler.ts`, when `addMember` fails after `userRepository.create` on the invitation-less path (flag on), the new user is left with the org id and profile but no membership. Create the user and the membership in one step (or compensate by deleting the user) and add tests
- [ ] T100 [P] [US3] `packages/trpc/server/routers/publicViewer/event.handler.ts` passes the client-supplied `org` straight to `getPublicEvent`; take the org slug from the request host org (`getHostOrganization`) instead, so a booking page can't load another organization's event through the tRPC call. Add a test
- [ ] T101 [US6] With the flag on, `apps/web/server/lib/[user]/[type]/getServerSideProps.ts` indexes a booking page only when `OrganizationSettings.allowSEOIndexing` is true, and that column defaults to `false`. Make the T061 switch-over migration set `allowSEOIndexing = true` for BlueBee (and default it for organizations created by `OrganizationService.create`), so public pages don't become `noindex` at go-live
- [ ] T102 [US5] Move redirects are now 308s (`apps/web/lib/handleOrgRedirect.ts`, `apps/web/app/WithAppDirSsr.tsx`, `apps/web/app/WithEmbedSSR.tsx`) and browsers cache them, so disabling a redirect when the old org reuses the username (US5-6) does not reach visitors who already followed it. Document this in `contracts/infra-owner-checklist.md` or send a bounded `Cache-Control` on those redirects
- [ ] T150 [US2] With the flag on, make the shared tRPC procedures `createEventPbacProcedure` and `eventOwnerProcedure` (`packages/trpc/server/routers/viewer/eventTypes/util.ts`) and the notetaker `assertActorIsMember` (`packages/features/notetaker/services/NotetakerSharingSettingsService.ts`) refuse callers outside the team's organization with NOT_FOUND instead of FORBIDDEN (FR-008). Add tests
- [ ] T151 Close the cross-team hole in webhook create without the flag (with the flag on, T037 added an accepted-membership check that answers NOT_FOUND): `packages/trpc/server/routers/viewer/webhook/create.handler.ts` accepts any `input.teamId` (the membership check runs only for `includeMemberMeetings`). Require team admin/owner membership unconditionally, and confirm whether team webhooks currently fail at runtime from mixing the `teamId` scalar with a `user` connect. Add tests
- [ ] T170 [P] [US3] Secondary-email verification links (`sendEmailVerification` with `secondaryEmailId` in `packages/features/auth/lib/verifyEmail.ts`, called from `packages/trpc/server/routers/loggedInViewer/addSecondaryEmail.handler.ts`) fall back to `WEBAPP_URL`, because `getBaseUrlForEmail` looks up the secondary address, which is not on a user record. Pass the owning user id (or base URL) from the caller. Add tests

---

## Dependencies and execution order

- **Phase 1 → Phase 2**: T001–T003 first.
  - T004–T005 (PR 1) before anything that reads `customDomain`.
  - T006–T011 (PRs 2–3) before T012–T022 and every story.
- **US1 (Phase 3)** depends on Phase 2 PRs 1–3 only (it doesn't need routing). It can merge early because it is hidden by the flag.
- **US2 (Phase 4)** depends on T010 (`OrganizationMembershipService`) and T013 (`getOrgFromRequest`).
- **US3 (Phase 5)** depends on T012–T022. Within US3:
  - T038–T046 come before the sweeps.
  - The sweeps T047–T060 are mutually independent.
- **US6 (Phase 6)**: T061 can be written anytime after T005. It must be applied in production before the flag is turned on. T062 comes last, after rollout verification.
- **US4 (Phase 7)** depends on US2 (T031, T034) and T010.
- **US5 (Phase 8)** depends on T010, T040 (redirect reading) and US1. It is required before BespokeSoft and JellyMatch get members.
- **Go-live gate**: Phases 2–8 merged, T061 applied, owner checklist done, then set the flag.

## Parallel opportunities

- Phase 2: T006 ‖ T007; T021 ‖ T022.
- US1: T025 ‖ T028 ‖ T029 after T023/T027.
- US3: T050–T056 (client sweep PRs) are all independent; T058–T060 are independent once T057 has merged.
- US2: T032, T035 and T037 run in parallel with their PR's main task.

## Implementation strategy

1. **MVP**: Phase 1 + Phase 2 (PRs 1–3) + US1. Instance admins can create organizations (flag on, on scratch).
2. Then US2 + US3 + US6, which make organizations real and safe to turn on in production.
3. Then US5 (needed to populate BespokeSoft and JellyMatch) and US4 (self-management).
4. Each PR is squash-merged into `develop` when its checks pass (the owner's standing instruction). Production stays unchanged until the owner applies the migrations and sets `ORGANIZATIONS_ENABLED`.
