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
- [X] T024 [US1] Implement owner assignment in `OrganizationService.create`:
  - An existing user is added through `OrganizationMembershipService.addMember(role OWNER)`.
  - If the user is in another org and `confirmMoveOwner` is not set, return `PreconditionFailed`. With confirmation, use the move from T067, or until T067 lands refuse with a clear error. (Done in T068: a confirmed owner is moved with `OrganizationMoveService.moveUser`, role OWNER.)
  - An unknown email creates a `VerificationToken` for the org team and sends `TeamInviteEmail` with the link on the org's base URL.
  - Log `action: "organization.create"` with ids only (FR-023).

  Update `OrganizationService.test.ts`
  - NOTE: `update.ownerUserId` is additive (`OrganizationMembershipService.grantOwner`): the user becomes an owner and existing owners keep their roles; a user in another organization is refused (no move on update). The admin edit form has an "Add owner" picker
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
- [X] T034 [US2] Signup in `apps/web/app/api/auth/signup/handlers/selfHostedHandler.ts`:
  - Without a token (~line 169), the user joins the host org (`getOrgFromRequest`), which on the default domain is the default org (FR-013).
  - With a token, the user joins the token team's parent org.
  - The membership is written through `OrganizationMembershipService.addMember`.

  Also update `packages/features/auth/signup/utils/createOrUpdateMemberships.ts` and `TeamMembersService.completeInviteSignup`. Add tests
  - NOTE: invite completion asks organization invitees without a username to choose one (free in the inviting organization only), then writes the org Profile and membership through `OrganizationMembershipService.addMember`
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

- [X] T050 [P] [US3] PR 16.1, auth:
  - `apps/web/modules/auth/{logout-view,team-invite-view,verify-view}.tsx`
  - `apps/web/modules/auth/hooks/useRedirectToLoginIfUnauthenticated.tsx`
  - `apps/web/modules/signup-view.tsx`
  - `apps/web/components/setup/AdminUser.tsx`
- [X] T051 [P] [US3] PR 16.2, booking pages:
  - `apps/web/modules/bookings/components/{BookerWebWrapper,event-meta/AvailableEventLocations,event-meta/Members}.tsx`
  - `packages/features/bookings/components/Header.tsx`
  - `apps/web/app/(booking-page-wrapper)/{[user]/page,[user]/[type]/page,booking/[uid]/page,team/[slug]/[type]/page}.tsx`
- [X] T052 [P] [US3] PR 16.3, event types:
  - `apps/web/modules/event-types/components/{CreateEventTypeDialog,DuplicateDialog,EventTypeWebWrapper,locations/Locations,tabs/setup/EventSetupTabWebWrapper}.tsx`
- [X] T053 [P] [US3] PR 16.4, settings and teams:
  - `apps/web/modules/settings/my-account/{appearance-view,profile-view}.tsx`
  - `apps/web/modules/settings/teams/team-profile-view.tsx`
  - `apps/web/modules/teams/views/teams-listing-view.tsx`
  - `apps/web/app/(use-page-wrapper)/teams/new/{create-team-view,team-public-preview}.tsx`
  - `apps/web/app/(use-page-wrapper)/(main-nav)/teams/page.tsx`
  - `apps/web/components/ui/UsernameAvailability/{index,PremiumTextfield}.tsx`
- [X] T054 [P] [US3] PR 16.5, users, shell and webhooks:
  - `apps/web/modules/users/components/{UsersTable,UserTable/UserListTable,UserTable/EditSheet/EditUserSheet}.tsx`
  - `apps/web/modules/shell/{SideBar,navigation/useMobileMoreItems}.tsx`
  - `apps/web/modules/webhooks/{components/WebhookForm,views/webhooks-view}.tsx`
  - `apps/web/app/(use-page-wrapper)/settings/(settings-layout)/SettingsLayoutAppDirClient.tsx`
- [X] T055 [P] [US3] PR 16.6, apps:
  - `apps/web/components/apps/{AppPage,alby/Setup,btcpayserver/Setup,wipemycalother/confirmDialog}.tsx`
  - `apps/web/components/getting-started/components/AppConnectionItem.tsx`
  - `apps/web/modules/apps/{components/AppCard,installation/[[...step]]/step-view}.tsx`
  - `packages/app-store/_utils/useAddAppMutation.ts`
- [X] T056 [P] [US3] PR 16.7, the rest:
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
- [X] T060 [P] [US3] PR 18.3: payment apps `stripepayment`, `paypal`, `hitpay`, `lyra`, plus `packages/app-store/_utils/paid-apps.ts`
  - Switched `stripepayment` (add, callback, setup page), `lyra` and `vital` (moved from T059). `paypal` and `hitpay` build no OAuth `redirect_uri`; their payment return and webhook URLs have no request in scope (T163). `_utils/paid-apps.ts` has no callers (T164)

**Checkpoint**: S4 (links), S5, S8, S9 and S10 pass on scratch.

---

## Phase 6: User Story 6 – Existing data moves into BlueBee (P1)

**Goal**: everyone is in an organization, with nothing visibly changing.
**Independent test**: quickstart S1, plus the counts on a copy of production.

- [X] T061 [US6] PR 22: write the repeat-safe data migration `packages/prisma/migrations/20261107000100_organizations_bluebee_switchover/migration.sql` implementing data-model.md Change 2, steps 1–6:
  - BlueBee `slug = 'bluebee'`, `customDomain = 'cal.bluebee.marketing'`.
  - Use `WHERE NOT EXISTS` / `ON CONFLICT DO NOTHING`.
  - Membership role OWNER "for `users.role = 'ADMIN'`", MEMBER otherwise.
  - Print counts with `RAISE NOTICE` before and after.

  Rehearse it on a scratch copy twice: the second run must change nothing. The owner applies it to production
- [ ] T062 [US6] PR 23 (only after the rollout is verified): change `User.organizationId` to `Int` with `onDelete: Restrict` in `packages/prisma/schema.prisma`, and create a migration that first runs `DO $$ BEGIN IF EXISTS (SELECT 1 FROM users WHERE "organizationId" IS NULL) THEN RAISE EXCEPTION ...` and then `ALTER COLUMN ... SET NOT NULL`. Fix the type errors this causes (`yarn type-check:ci --force`)
  - POSTPONED: implemented and ready, merge gated. Preparation merged (new users get the default organization; tests, seeds and fixtures assign one): #298, #301, #312, #322, #323, #324, #328, plus part 8 (flag-off username checks). The strict code, the migration and the schema change are stacked draft PRs #346 → #347 → #348. Open question for the owner: merging #346 makes the next deploy need `db-deploy` (which applies the T061 switch-over and the T062 migration together) and makes the default organization mandatory for new users. This task says "only after the rollout is verified", so merge the stack back to back only once T061 is applied in production and the rollout is verified. Both migrations were rehearsed on a disposable Postgres.

---

## Phase 7: User Story 4 – Org owners and admins manage their own organization (P2)

**Goal**: org admins handle members and teams themselves.
**Independent test**: quickstart S11.

**PR 24**

- [X] T063 [US4] Create the `viewer.organization` router in `packages/trpc/server/routers/viewer/organization/_router.ts` with `current`, `listMembers`, `inviteMember`, `updateRole`, `removeMember` and `listTeams`, as in contracts/trpc-organizations.md. The org always comes from `ctx.user.organizationId`. Register it in `packages/trpc/server/routers/viewer/_router.tsx`. Add tests
- [X] T064 [US4] Add `inviteMember`, `removeMember` (a move to the default org, FR-011) and `listTeams` to `OrganizationMembershipService`, with the role rules. Log the actions with ids only. Add tests
- [X] T065 [US4] Extend the `viewer.teams.*` permission checks (`packages/features/membership/services/TeamMembersService.ts`, `TeamProfileService.ts`, delete team) so that "team admin **or** org ADMIN/OWNER of the team's parent org" may act. Add tests

**PR 25**

- [X] T066 [US4] Create `apps/web/app/(use-page-wrapper)/settings/(settings-layout)/organization/{members,teams}/page.tsx`, with the flag check and membership check in `page.tsx`. Create the views `apps/web/modules/organizations/views/{org-members-view,org-teams-view}.tsx` (read-only for MEMBER), add the nav entry in `SettingsLayoutAppDirClient.tsx`, the i18n strings and view tests

---

## Phase 8: User Story 5 – An instance admin moves users and teams (P2)

**Goal**: populate BespokeSoft and JellyMatch from BlueBee.
**Independent test**: quickstart S4.

**PR 26**

- [X] T067 [US5] Implement `OrganizationMoveService` in `packages/features/organizations/services/OrganizationMoveService.ts`:
  - `moveUser({ userId, toOrganizationId, newUsername? })` removes the user's memberships of old-org teams, updates `User.organizationId`, the `Profile` and the org `Membership`, writes `TempOrgRedirect { from: oldUsername, fromOrgId: oldOrgId, type: User, toUrl: https://<new domain>/<username>, enabled: true }`, and returns CONFLICT when the username is taken in the target org.
  - `previewMoveTeam` and `moveTeam({ outsideMembers: "move" | "remove", newSlug? })` set `parentId` and write the `Team` redirect.
  - Disable redirects (`enabled = false`) when the old org reuses the `from` username or slug. Hook this into `addMember` and team create/rename.

  Add a full test suite
- [X] T068 [US5] Add `moveUser`, `previewMoveTeam` and `moveTeam` to `packages/trpc/server/routers/viewer/admin/organizations/_router.ts`, with tests. Wire `confirmMoveOwner` in `OrganizationService.create` to `moveUser`

**PR 27**

- [X] T069 [US5] Add a "Move to organization" action in the admin user edit view `apps/web/modules/users/views/users-edit-view.tsx` (target org select, plus a username prompt on CONFLICT) and a team move dialog in `apps/web/modules/organizations/views/organization-form-view.tsx` or the admin teams list (preview of outside members, move/remove choice, new slug). Add i18n strings and tests

---

## Phase 9: Polish and cross-cutting

- [X] T070 [P] Delete `packages/features/profile/lib/createAProfileForAnExistingUser.ts` and `UserRepository.findManyByOrganization` (dead, owner-approved) (with PR 26)
- [ ] T071 [P] Add a Playwright spec `apps/web/playwright/organizations.e2e.ts` for quickstart S2, S4, S5 and S6, run on the scratch setup only and with the owner's go-ahead
- [X] T072 Document the rollout in `specs/005-organizations/quickstart.md` §5, finalise `contracts/infra-owner-checklist.md` with the actual OAuth apps in use (quickstart step 0), and add `ORGANIZATIONS_ENABLED` / `AUTH_TRUST_HOST` notes to `.env.example`
- [ ] T073 Run the full quickstart S1–S13 on the scratch setup and record the results in the last PR description
- [X] T074 Create OAuth (Google, Azure AD) sign-ups in the request organization when the flag is on. Today they are created without an organization, so the `signIn` domain policy refuses them. Add tests
- [X] T075 In `getServerSession` / `ensureSession`, check on each request that the database `user.organizationId` matches the request organization. This defends against a session token copied to another domain. Add tests
- [X] T076 Owner checklist (`contracts/infra-owner-checklist.md`): set `AUTH_TRUST_HOST` only together with `ORGANIZATIONS_ENABLED`; Caddy must overwrite `X-Forwarded-*` headers; the Node ports must not be reachable from outside
- [X] T110 [US3] Run the T045 host-organization check (`assertEventTypeInHostOrganization` in `packages/features/organizations/lib/resolveBookingHostOrganization.ts`) for instant meetings and API v1 bookings (`createBookingForApiV1`), which bypass `RegularBookingService.handler`. Add tests
  - NOTE: this repo has no API v1 app and no instant-meeting booking service; `createBookingForApiV1` runs the same `handler` as web bookings, so the check already applies. Covered by a test in `handleNewBooking/test/organization-host.test.ts`.
- [X] T111 [US3] In `packages/trpc/server/routers/viewer/slots/getSchedule.handler.ts`, refuse (NOT_FOUND) a direct `eventTypeId` whose owner/team organization differs from the request organization; T046 only scopes slug lookups. Add tests
- [X] T112 [P] [US3] Let `apps/api/v2` bookings skip the host-organization check explicitly (instead of relying on its Host not resolving): with a loopback Host the resolver returns the default org and would refuse other organizations' event types. Pass a flag from `packages/platform/libraries` into `RegularBookingService`. Add tests
- [X] T120 [P] [US2] Add an instance-admin teams list (none exists today) with the `organization: { id, name }` column and `organizationId` filter required by US2-5 / contracts/trpc-organizations.md, e.g. `apps/web/app/(use-page-wrapper)/settings/(admin-layout)/admin/teams/page.tsx` + an admin `teams.listPaginated` procedure (split out of T032)
- [ ] T130 [US2] Keep the org `Profile.username` in sync when an org member changes their username in `packages/trpc/server/routers/viewer/me/updateProfile.handler.ts` (data-model.md: `users.username` equals `Profile.username`; both are written on change). Today only `users.username` is updated. Add tests
- [X] T131 [US2] In `TeamMembersService.acceptPendingInvitesOnSignup` (`packages/features/membership/services/TeamMembersService.ts`), skip pending invites to teams outside the organization the new user just joined when the flag is on. Add tests
- [X] T132 [US2] In `apps/web/app/api/auth/signup/handlers/selfHostedHandler.ts`, when `addMember` fails after `userRepository.create` on the invitation-less path (flag on), the new user is left with the org id and profile but no membership. Create the user and the membership in one step (or compensate by deleting the user) and add tests
- [X] T100 [P] [US3] `packages/trpc/server/routers/publicViewer/event.handler.ts` passes the client-supplied `org` straight to `getPublicEvent`; take the org slug from the request host org (`getHostOrganization`) instead, so a booking page can't load another organization's event through the tRPC call. Add a test
- [X] T101 [US6] With the flag on, `apps/web/server/lib/[user]/[type]/getServerSideProps.ts` indexes a booking page only when `OrganizationSettings.allowSEOIndexing` is true, and that column defaults to `false`. Make the T061 switch-over migration set `allowSEOIndexing = true` for BlueBee (and default it for organizations created by `OrganizationService.create`), so public pages don't become `noindex` at go-live
- [X] T102 [US5] Move redirects are now 308s (`apps/web/lib/handleOrgRedirect.ts`, `apps/web/app/WithAppDirSsr.tsx`, `apps/web/app/WithEmbedSSR.tsx`) and browsers cache them, so disabling a redirect when the old org reuses the username (US5-6) does not reach visitors who already followed it. Document this in `contracts/infra-owner-checklist.md` or send a bounded `Cache-Control` on those redirects
  - DECIDED: keep the 308 (FR-018 requires a permanent redirect). These booking pages render dynamically, so Next.js already sends `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` on the redirect and browsers don't cache it. Documented in `contracts/infra-owner-checklist.md` ("Move redirects"), including a `curl -sI` check after the first move and "no caching in Caddy"
- [X] T150 [US2] With the flag on, make the shared tRPC procedures `createEventPbacProcedure` and `eventOwnerProcedure` (`packages/trpc/server/routers/viewer/eventTypes/util.ts`) and the notetaker `assertActorIsMember` (`packages/features/notetaker/services/NotetakerSharingSettingsService.ts`) refuse callers outside the team's organization with NOT_FOUND instead of FORBIDDEN (FR-008). Add tests
- [X] T151 Close the cross-team hole in webhook create without the flag (with the flag on, T037 added an accepted-membership check that answers NOT_FOUND): `packages/trpc/server/routers/viewer/webhook/create.handler.ts` accepts any `input.teamId` (the membership check runs only for `includeMemberMeetings`). Require team admin/owner membership unconditionally, and confirm whether team webhooks currently fail at runtime from mixing the `teamId` scalar with a `user` connect. Add tests
- [X] T170 [P] [US3] Secondary-email verification links (`sendEmailVerification` with `secondaryEmailId` in `packages/features/auth/lib/verifyEmail.ts`, called from `packages/trpc/server/routers/loggedInViewer/addSecondaryEmail.handler.ts`) fall back to `WEBAPP_URL`, because `getBaseUrlForEmail` looks up the secondary address, which is not on a user record. Pass the owning user id (or base URL) from the caller. Add tests
- [X] T160 [P] [US3] OAuth token refresh still sends `WEBAPP_URL` as `redirect_uri` without a request in scope: `packages/app-store/hubspot/lib/CrmService.ts`, `packages/app-store/salesforce/lib/CrmService.ts`, `packages/app-store/basecamp3/lib/helpers.ts`. Verify each provider ignores `redirect_uri` on refresh grants; if one checks it, store the redirect URI used at connect time on the credential and reuse it
  - Verified, no code change beyond why-comments: Salesforce `refreshAccessToken` sends no `redirect_uri`; HubSpot and 37signals Launchpad don't validate `redirect_uri` on refresh grants (Basecamp already sends the bare origin, which never matched the connect-time URI). No credential storage needed
- [X] T161 [P] [US3] Client `returnTo` props built from `WEBAPP_URL` in `packages/app-store/{closecom,hubspot,pipedrive-crm,salesforce,zoho-bigin,zohocrm,stripepayment,paypal,hitpay}/components/EventTypeAppCardInterface.tsx` send org-domain users back to the default domain after installing; use `window.location.origin` (or `OrgBaseUrlContext`). Add tests
  - Shared client-safe `packages/app-store/_utils/getAppReturnToUrl.ts` (`window.location.origin`, `WEBAPP_URL` on the server); `OrgBaseUrlContext` lives in features and is out of reach for app-store
- [X] T162 [P] [US3] Stripe billing-portal return URL defaults to `${WEBAPP_URL}/settings/billing` in `packages/app-store/stripepayment/api/portal.ts` and `packages/app-store/stripepayment/lib/services/base/BillingPortalService.ts`; pass the request and use `getOAuthAppOrigin` / `getOAuthSafeRedirectOptions`. Add tests
  - `buildReturnUrl(req, returnTo)` in `portal.ts`; the unused protected `BillingPortalService.buildReturnUrl` was removed. A relative `returnTo` now falls back to the billing URL instead of throwing
- [X] T163 [US3] Booker-facing payment return URLs use `WEBAPP_URL` in `packages/app-store/paypal/lib/PaymentService.ts` and `packages/app-store/hitpay/lib/PaymentService.ts`; make them follow the booking's organization base URL (webhook URLs stay on `WEBAPP_URL`). Add tests
  - `handlePayment` passes `evt.bookerUrl` (from `OrganizationUrlService`) as an optional trailing `bookerUrl` to `IAbstractPaymentService.create`/`collectCard`. PayPal `collectCard` is unreachable today (`paymentOptionEnum` only allows `ON_BOOKING`)
- [X] T164 [P] Delete dead `packages/app-store/_utils/paid-apps.ts` (no callers; owner approval for deletions)
- [X] T165 [P] [US3] `packages/app-store/{feishucalendar,larkcalendar}/api/callback.ts` catch blocks redirect to `state.returnTo` unvalidated; route it through `getSafeRedirectUrl` with `getOAuthSafeRedirectOptions(req)` (relative fallback kept). Add tests
- [X] T230 [US3] With `skipHostOrganizationCheck` (API v2), `loadAndValidateUsers` in `packages/features/bookings/lib/handleNewBooking/loadUsers.ts` still resolves the dynamic-group org slug from the API's own Host (loopback → default organization) when the flag is on, so non-platform API v2 dynamic group bookings only find default-organization users. Decide whether API v2 should scope by `forcedSlug` / the authenticated user's organization instead, and add tests
- [X] T250 [US2] OAuth (Google, Azure AD) users created in the `signIn` callback (`packages/features/auth/lib/next-auth-options.ts`) never run `TeamMembersService.acceptPendingInvitesOnSignup` (only `CalComAdapter.createUser` in `next-auth-custom-adapter.ts` does), so pending team invites are not materialised for them, with the flag on or off. Call it after the T074 org membership is created and add tests
- [X] T252 [US6] With the flag off, OAuth sign-ups in the `signIn` callback (`packages/features/auth/lib/next-auth-options.ts`, T062 part 2) and `CalComAdapter.createUser` get the default organization's id but no `Profile`/`Membership`, while `selfHostedHandler` sign-ups call `OrganizationMembershipService.addMember` for it. T074 only adds the membership when the flag is on; decide whether the flag-off paths should call `addMember` too before T062 makes `organizationId` NOT NULL. Add tests
  - DECIDED: yes for the `signIn` callback: with the flag off, new OAuth users get `addMember` for the default organization (same as `selfHostedHandler`; the user is deleted if it fails). `CalComAdapter.createUser` (magic-link sign-ups) cannot, because those users have no username; see T330
  - Decided: when API v2 skips the host-organization check and passes an org slug (`forcedSlug`, from the 2024-04-15 `orgSlug` body field), `RegularBookingService` no longer passes the API's own Host to `loadAndValidateUsers`, so the dynamic group resolves in that organization. Without `forcedSlug` the default-organization fallback is kept. The authenticated user's organization was rejected because the booker of a public dynamic group need not belong to it
- [X] T251 [US2] The T075 organization check covers `getServerSession` / `ensureSession` only; the next-auth `/api/auth/session` endpoint (client `useSession`) still returns the JWT session on any host. Decide whether the `session` callback in `getOptions` (`packages/features/auth/lib/next-auth-options.ts`, which has `getRequestHeaders`) should also return an empty session when the DB `user.organizationId` differs from the request organization. Add tests
  - DECIDED: yes. With the flag on, the `session` callback in `getOptions` runs `isSessionInRequestOrganization` and returns `{}` (which next-auth's client reads as signed out) on a mismatch, a lookup error, or missing request headers. It does not throw, because next-auth would then clear the session cookie
- [ ] T220 [US2] The T061 switch-over gives BlueBee members without a username `organizationId` and a membership but no org `Profile` (`Profile.username` is NOT NULL). When such a user sets a username (`packages/trpc/server/routers/viewer/me/updateProfile.handler.ts`, together with T130), create their org `Profile` through `OrganizationMembershipService`, and make sure profile/session code tolerates an org member without a profile until then. Add tests
- [X] T221 [US6] With `ORGANIZATIONS_ENABLED` off, `UserRepository._getWhereClauseForFindingUsersByUsername` (`packages/features/users/repositories/UserRepository.ts`, used by `apps/web/server/lib/[user]/getServerSideProps.ts`) matches only users with `organization: null` (team pages similarly use `parentId: null`), so once the T061 switch-over runs, booking pages 404 until the flag is on. Either make the flag-off lookups ignore the organization, or add an explicit step to `contracts/infra-owner-checklist.md` to apply T061 and enable the flag in the same window (the Go-live gate currently implies a gap between the two)
- [X] T260 [US6] With `ORGANIZATIONS_ENABLED` off after the T061 switch-over, API v2 lookups still filter on "no organization" and will match nobody: `apps/api/v2/src/modules/teams/teams.repository.ts` (~122), `apps/api/v2/src/modules/memberships/memberships.repository.ts` (~106, ~153), `apps/api/v2/src/modules/oauth-clients/services/oauth-clients-users.service.ts` (~57), `apps/api/v2/src/modules/organizations/index/organizations.repository.ts` (~135). Confirm which of them this instance actually serves and apply the T221 rule (`outsideOrganizationsFilter`) where they are public lookups. Add tests
- [X] T261 [US6] With the flag off after T061, the admin SMS lock-state team list (`packages/lib/smsLockState.ts` ~49/56, `packages/trpc/server/routers/viewer/admin/setSMSLockState.handler.ts` ~70) filters `parentId: null` and shows no teams. Apply `outsideOrganizationsFilter` there. Add tests
- [X] T262 [US6] With the flag off after T061, `getPublicEvent` (`packages/features/eventtypes/lib/getPublicEvent.ts`) still enriches owners/hosts with their BlueBee org profile (`enrichUserWithItsProfile`), so booking pages may show the organization name/avatar instead of the user's. Check in QA on a scratch DB and, if so, use the personal profile while the flag is off. Add tests
- [ ] T263 [US6] After the T062 stack (#346), `findDefaultOrganizationId` (`packages/features/organizations/lib/defaultOrganization.ts`) throws when there is no default organization. Rename it to `requireDefaultOrganizationId` at its call sites (`selfHostedHandler.ts`, `calcomSignupHandler.ts`, `TeamMembersService.ts`, `next-auth-options.ts`, `next-auth-custom-adapter.ts`, `users/add.handler.ts`) and their test mocks
- [ ] T264 [P] [US6] `packages/testing/src/lib/bookingScenario/bookingScenario.ts` `addUsersToDb` keeps an optional fixture `organizationId` behind a type-only `@ts-expect-error` after T062 (#348). Give scenario users a real default organization, and check booking tests that branch on `user.organizationId`. Add tests
- [ ] T265 [P] Integration tests that fail on `develop` as well (seen while verifying T062 on a scratch database): five ad-hoc booking tests in `packages/features/notetaker/repositories/PrismaBookingNotetakerRepository.integration-test.ts` (`Unique constraint failed on idempotencyKey`, from `packages/prisma/extensions/booking-idempotency-key.ts`), seven in `apps/web/app/api/notetaker/events/__tests__/route.integration-test.ts`, and one in `packages/features/notetaker/tests/quickstartLifecycle.integration-test.ts`. Fix the fixtures or the code
- [X] T320 [US6] Security, before the flag flips: the Community Edition `PermissionCheckService` stubs (`checkPermission`/`hasPermission` always `true`) in `packages/features/bookings/services/BookingAccessService.ts` (Cases 3 and 5: any logged-in user can open team bookings and personal bookings of anyone in a team — pre-existing), `getPublicEvent.ts`, `getEventTypesByViewer.ts`, `packages/trpc/server/routers/viewer/eventTypes/util.ts`, `bookings/get.handler.ts`, `teamsAndUserProfilesQuery.handler.ts` and `packages/trpc/server/procedures/pbacProcedures.ts` (with the flag on, every org member passes org-level PBAC procedures). Replace them with real role checks (membership role OWNER/ADMIN) and add tests
  - DONE (split with the org-security-2 session to avoid duplicate work): `getPublicEvent.ts` now shows private team members only to accepted team ADMIN/OWNER (or, flag on, accepted ADMIN/OWNER of the parent organization) via the shared `TeamRolePermissionService` (#336); before, any signed-in user saw them. `getEventTypesByViewer.ts` uses the same service, so team groups are no longer all read-only and managed event types show again for team admins/owners. `BookingAccessService` Cases 3/5 and `bookings/get.handler.ts` are T310 (#336, #337), `eventTypes/util.ts` is T313 (#338), `teamsAndUserProfilesQuery.handler.ts` is T311 and `pbacProcedures.ts` is T312 (org-security-2)
- [X] T321 [US6] With the flag off after T061, `apps/web/lib/signup/getServerSideProps.tsx` (~175–194) sets `isATeamInOrganization = tokenTeam.parentId !== null`, so team-invite sign-ups are treated as BlueBee org invites (`orgSlug = "bluebee"`, `isOrgInviteByLink`). Gate on `isOrganizationsEnabled()` (or `withoutOrganizationParent`), QA the sign-up view, add tests
  - DONE: `getServerSideProps.tsx` and `selfHostedHandler.ts` pass the token team through `withoutOrganizationParent`, so with the flag off a team invite sign-up is a plain team invite again (no BlueBee `orgSlug`, no org invite by link, no BlueBee-scoped username check, default-organization membership via `addMember`, no `joinAnyChildTeamOnOrgInvite`). Invites to an organization itself (`isOrganization`) are unchanged; flag on unchanged
- [X] T322 [US6] With the flag off after T061, `UserRepository.getUserAdminTeams` (`packages/features/users/repositories/UserRepository.ts`, used by app install, `appCredentialsByType`, apps homepage) lists BlueBee as an install target for instance admins; an app installed on BlueBee reaches all team events via `getAllCredentials.ts` (~117). Exclude organization teams while the flag is off; also mask `team.parent` in `apps/web/lib/apps/installation/[[...step]]/getServerSideProps.ts` (~112–116, ~163–166). Add tests
  - DONE: with the flag off `UserRepository.getUserAdminTeams` lists only teams where the user is an accepted ADMIN/OWNER and never organization teams, so BlueBee is no longer an app install target (app install, `appCredentialsByType`, apps homepage, `throwIfNotHaveAdminAccessToTeam`). Flag on: the parent-organization branch compared `Membership.id` with the user id (random teams granted); it now matches `userId` with `accepted: true`. The installation page masks `team.parent` while the flag is off (`installTargetTeam.ts`). `getAllCredentials.ts` ~117 needs no change: with the flag off the user profile has no organization (T262), so BlueBee credentials are never collected and line 117 only filters credentials already collected
- [X] T323 [P] [US6] `packages/features/auth/signup/utils/validateUsername.ts` (~117–125) switches to an org-scoped username check via `team.parentId`; after T061 it checks BlueBee profiles while the flag is off. Use the flag-off (global) check while organizations are disabled. Add tests
  - DONE: `validateAndGetCorrectedUsernameInTeam` masks the team with `withoutOrganizationParent`, so with the flag off a sub-team of BlueBee gets the global username check; organization teams and flag on unchanged
- [X] T324 [P] [US6] API v2 still picks the BlueBee profile as the user's main profile after T061 (`apps/api/v2/src/modules/users/services/users.service.ts` `getUserMainProfile` and its callers, `extract-user-context.ts` ~22, `teams.repository.ts` `getTeamsUserIsMemberOf` ~65). API v2 is not served on this instance; if it is ever enabled before the flag, mirror T262 (personal profile while the flag is off) using `apps/api/v2/src/lib/organizations-enabled.ts`
  - DONE: with the flag off `UsersService.getUserMainProfile` ignores switch-over (non-platform) organization profiles and `movedToProfile`, and `getUserMainOrgId` no longer falls back to `users.organizationId` (BlueBee), so callers get the personal profile as before T061. `extract-user-context.ts` sets `userOrgId` only for active profiles. Platform organizations (never part of the switch-over) and flag on are unchanged (`isOrganizationProfileActive` in `apps/api/v2/src/lib/organizations-enabled.ts`). `teams.repository.ts` `getTeamsUserIsMemberOf` has no callers, so it is left as is
- [X] T325 [US6] Flag on: T061 leaves `EventType.profileId` NULL and the BlueBee profiles have no `movedFromUser`, so `EventTypeRepository.findAllByUpId` (`packages/features/eventtypes/repositories/eventTypeRepository.ts` ~252–300) with a `prof-` session upId may hide users' existing event types from /event-types once the flag is on. Verify on a scratch DB with the flag on and fix (lookup or migration) before go-live
  - DONE: confirmed on a scratch database (all migrations incl. the switch-over, flag on): a `prof-` upId returned only event types with that `profileId`, hiding the legacy ones. `findAllByUpId` and `findAllByUpIdWithMinimalData` now also return `profileId` NULL event types of the profile's own user (`movedFromUser` when set), since every user has exactly one profile. Lookup fix, no data migration; covered by unit tests and `EventTypeRepository.findAllByUpId.integration-test.ts` (fails without the fix). Inert with the flag off (sessions use `usr-` upIds, T262)
- [X] T281 [US4] Organization owners cannot drop the redirect a removal (T181) leaves on their domain except by reusing the username. Consider a "remove without redirect" option in `apps/web/modules/organizations/components/org-member-actions.tsx` / `OrganizationMembershipService.removeMember` if owners ask for it
  - DECIDED: no option for now. FR-018 and US5-5/US5-6 keep a move redirect until the old organization reuses the username, and T181 made removal a move, so links the removed member already sent keep reaching them. Owners can still drop it by reusing the username (US5-6); the task was conditional on owner demand and none has been raised. Revisit only if owners ask, as a flag on `removeMember` that skips `buildRedirect`
- [X] T280 [US5] The admin user update (`packages/trpc/server/routers/viewer/users/_router.ts`, `movedToProfileId` branch) rewrites every `User` `TempOrgRedirect` whose `from` is the old username across all organizations and points it at `WEBAPP_URL/<new username>`. Scope it to the user's own organization and build `toUrl` with `OrganizationUrlService`, or drop it now that moves keep the profile. Add tests
  - DONE: the cross-organization `updateMany` is gone. After an admin rename (and a self rename in `updateProfile.handler.ts`), `repointUserRedirectsForRename` (`packages/features/organizations/lib/`) rewrites only `User` redirects whose `toUrl` is the user's old page in their own organization (`OrganizationUrlService.getBaseUrl`) to the new username. Inert while ORGANIZATIONS_ENABLED is off
- [X] T270 [US2] Pass the new user's organization to `TeamMembersService.acceptPendingInvitesOnSignup` (T131 `organizationId`) from the OAuth sign-up path `packages/features/auth/lib/next-auth-custom-adapter.ts` once T074 gives OAuth users an organization, and from `apps/web/app/api/auth/signup/handlers/calcomSignupHandler.ts`; today only `selfHostedHandler.ts` scopes pending invites to the joined organization. Add tests
- [X] T330 [US6] `CalComAdapter.createUser` (`packages/features/auth/lib/next-auth-custom-adapter.ts`, next-auth magic-link sign-ups) creates users without a username in the default organization, so they get no org `Profile`/`Membership` (`addMember` needs a username), and with the flag on they land in the default organization whatever the request host. Decide (give them a generated username and call `addMember`, or refuse magic-link sign-up for unknown emails) before T062 makes `organizationId` NOT NULL. Add tests
  - DECIDED: give them a generated username and call `addMember`, like the OAuth `signIn` path (T252). `createUser` now uses `findNewUserOrganizationId` (request organization with the flag on, default organization otherwise; moved to `packages/features/auth/lib/findNewUserOrganizationId.ts`) and `usernameSlug(email local part)` (`packages/features/auth/lib/usernameSlug.ts`, `user-xxxxxx` when the slug is empty), then `OrganizationMembershipService.addMember` as MEMBER. If `addMember` fails the user is deleted and next-auth shows `EmailCreateAccount`. `getBaseOptions` builds the adapter with `getRequestHeaders`. Refusing unknown emails was rejected because it would end magic-link sign-ups that work today

---
- [X] T180 [US4] `OrganizationMembershipService.removeMember` refuses with CONFLICT `username_taken_in_default_organization` when the removed member's username is already used in the default organization (FR-011 gives no rule). Let the remover (or an instance admin) pick a new username, e.g. reuse T067 `moveUser({ newUsername })`, and surface the prompt in `apps/web/modules/organizations/components/org-member-actions.tsx`. Add tests
- [X] T181 [US4] Decide whether removing an org member (FR-011 move to the default org) should write a `TempOrgRedirect` for their old public URL like FR-005 moves do (FR-018 only covers instance-admin moves); today it writes none. Implement in `PrismaOrganizationMembershipRepository.moveToOrganization` / T067 if yes. Add tests
  - DECIDED: yes. Removal is a move (US4-5, "Link redirect: left by a move"), so via T200 it writes the same `User` redirect as FR-005 moves; links already sent keep working and the redirect is dropped as soon as the organization reuses the username (US5-6)
- [X] T182 [US4] Profile-less org invitees (created by `viewer.organization.inviteMember` / T031 with `username = null`) have `ctx.user.organizationId = null` (it comes from the session profile, `packages/features/auth/lib/userFromSessionUtils.ts`), so they get NOT_FOUND on `/settings/organization/*` and the org invite landing sends them to "/". Resolve together with the T034 username question, then point org invites (`apps/web/app/(use-page-wrapper)/auth/team-invite/page.tsx`, `apps/web/modules/auth/team-invite-view.tsx`) at `/settings/organization/members`
  - NOTE: with the flag on, the session `organizationId` (and `viewer.me.get`) fall back to `users.organizationId` when the profile has no organization; org invites land on `/settings/organization/members`
- [X] T183 [P] `packages/features/teams/services/TeamProfileService.ts` imports schemas from `@calcom/trpc/server/routers/viewer/teams/teamProfile.schema` (features must not import trpc). Move `ZTeamProfileMetadataSchema`, `TEAM_LOGO_DATA_URL_PATTERN` and the input types into `packages/features/teams/` and re-export from the trpc schema file
- [X] T200 [US4] Make `OrganizationMembershipService.removeMember` (FR-011) delegate to `OrganizationMoveService.moveUser` with the default organization as target (covers T180's `newUsername` and, if decided, T181's redirect), and drop `PrismaOrganizationMembershipRepository.moveToOrganization`: it deletes and recreates the `Profile`, so event types lose their `profileId` and the session `upId` breaks, and it leaves `Host` rows on the old organization's team events. Add tests
- [X] T201 [US5] Disable move redirects (US5-6) on the remaining username-reuse paths: a user renaming themselves (`packages/trpc/server/routers/viewer/me/updateProfile.handler.ts`) or an admin renaming them (`packages/trpc/server/routers/viewer/users/_router.ts`) to a username freed by a move in their organization. Call `TempOrgRedirectRepository.disableByFrom({ fromOrgId, from: username, types: ["User"] })`. Add tests
- [X] T210 [US3] NextAuth Google/Microsoft SSO on organization domains: `apps/web/modules/signup-view.tsx` and `apps/web/modules/auth/login-view.tsx` still start SSO at `NEXT_PUBLIC_WEBAPP_URL/auth/sso/*` (kept in T050), so an organization member signing in on their organization domain gets the session cookie on `WEBAPP_URL`. Decide whether to register per-domain redirect URIs at Google/Microsoft and make the NextAuth provider callbacks host-aware, or to keep SSO on `WEBAPP_URL` and hand off to the organization domain after sign-in
  - DECIDED: per-domain sessions (research.md R6), no hand-off. The `/auth/sso/*` page does not exist in this repo, so the signup buttons now call next-auth `signIn("google" | "azure-ad")` on the current host, like `login-view.tsx` already did. `contracts/infra-owner-checklist.md` lists the per-domain `/api/auth/callback/*` registrations
- [X] T290 [US2] SECURITY (flag-independent): `createEventPbacProcedure` in `packages/trpc/server/routers/viewer/eventTypes/util.ts` uses a stub `PermissionCheckService` whose `checkPermission` always returns `true`, so any signed-in user passes for team event types on `eventTypes.delete`, `heavy.update`, `heavy.duplicate`, `get`, `getHostsForAssignment`, `getHostsForAvailability`, `exportHostsForWeights`, `getChildrenForAssignment`, `getHostsWithLocationOptions` and `massApplyHostLocation` (e.g. `delete.handler.ts` deletes by id with no further check). Replace the stub with a real check of `fallbackRoles` against accepted team membership (plus org ADMIN/OWNER of the parent organization when the flag is on). Add tests
- [X] T291 [P] [US2] With the flag on, `eventOwnerProcedure` and `createEventPbacProcedure` (`packages/trpc/server/routers/viewer/eventTypes/util.ts`) still answer FORBIDDEN for a personal event type owned by a user of another organization (T150 only covers team event types), which lets event type ids of other organizations be probed. Answer NOT_FOUND when the owner's organization differs from the caller's. Add tests
- [X] T310 [US2] SECURITY (flag-independent): `packages/features/bookings/services/BookingAccessService.ts` (and `packages/trpc/server/routers/viewer/bookings/get.handler.ts`) use a stub `PermissionCheckService` whose `checkPermission`/`hasPermission` always return `true`. Audit which booking access decisions rely on it and replace it with real membership-role checks (accepted team membership in the fallback roles, or accepted ADMIN/OWNER of the parent organization), as T290 did for `createEventPbacProcedure`. Add tests
- [X] T311 [US2] SECURITY (flag-independent): the remaining always-true `PermissionCheckService` stubs in `packages/trpc/server/routers/viewer/eventTypes/teamAccessUseCase.ts`, `getUserEventGroups.handler.ts`, `getActiveOnOptions.handler.ts`, `packages/trpc/server/routers/viewer/ooo/outOfOffice.utils.ts`, `packages/trpc/server/routers/viewer/me/checkForInvalidAppCredentials.ts` and `packages/trpc/server/routers/loggedInViewer/teamsAndUserProfilesQuery.handler.ts` should be replaced with real role checks (or removed where the check is moot). Check each for an exploitable path first and fix the exploitable ones before the rest. Add tests
- [X] T312 [P] SECURITY: the watchlist stubs (`packages/features/di/watchlist/containers/watchlist.ts`, `packages/features/watchlist/lib/service/OrganizationWatchlistQueryService.ts`, `OrganizationWatchlistOperationsService.ts`) always grant organization watchlist permissions. Replace them with an accepted org ADMIN/OWNER check. `packages/trpc/server/procedures/pbacProcedures.ts` (`createTeamPbacProcedure`, same stub) has no importers, so delete it (deletion needs owner approval) or fix it. Add tests
- [X] T313 [P] [US2] `eventOwnerProcedure` (`packages/trpc/server/routers/viewer/eventTypes/util.ts`) checks the team member's role but not `accepted`, so with the flag off a pending (invited, not accepted) ADMIN/OWNER can update/delete team event types. Require `accepted` (reuse `hasTeamEventRole` from `teamEventVisibility.ts`). Add tests
- [X] T360 [P] SECURITY: the always-true `PermissionCheckService` stubs remain in `packages/features/webhooks/lib/repository/WebhookRepository.ts` (webhook group permissions and allowed team ids) and `packages/trpc/server/routers/viewer/me/get.handler.ts` (`getTeamIdsWithPermission` for `team.update`). Check each for an exploitable path, then replace them with `TeamRolePermissionService` (`packages/features/membership/services/TeamRolePermissionService.ts`). Add tests
- [X] T361 [P] [US2] With organizations on, `TeamRolePermissionService` (used for `canCreateEventType` in `getUserEventGroups.handler.ts`) lets accepted parent-org ADMIN/OWNER create team event types, but `packages/trpc/server/routers/viewer/eventTypes/heavy/create.handler.ts` refuses org admins on purpose. Decide which rule is correct and align both. Add tests
- [ ] T362 [P] [US2] The assigned-users check in `eventOwnerProcedure` and `createEventPbacProcedure` (`packages/trpc/server/routers/viewer/eventTypes/util.ts`) accepts any team member, including pending (invited, not accepted) ones. Require `accepted`. Add tests
- [ ] T390 [P] SECURITY: `getFilteredWebhooksForUser` in `packages/features/webhooks/lib/repository/WebhookRepository.ts` still shows plain team MEMBERs the team's webhooks that have `userId` set (older or API-created rows), `secret` included, while `listWebhooks` now limits team webhooks to accepted ADMIN/OWNER. Decide whether members may read team webhooks at all and align both (and `getByViewer`). Add tests
- [ ] T391 [P] SECURITY: `listWebhooks` with `eventTypeId` (`packages/features/webhooks/lib/repository/WebhookRepository.ts`) does no access check of its own and relies on the caller procedure checking `eventType.userId === ctx.user.id`. Move or duplicate the event-type ownership/team-admin check into the handler path so team event-type webhooks (secrets) cannot be listed by non-admins. Add tests
- [ ] T392 [P] [US2] `canCreateEventType` in `packages/trpc/server/routers/viewer/eventTypes/getUserEventGroups.handler.ts` ignores the system-admin bypass that `heavy/create.handler.ts` allows, so the UI hides "create" for system admins who may create. Align (or drop the system-admin bypass). Add tests

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
