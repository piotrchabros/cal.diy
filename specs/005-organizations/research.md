# Research: Organizations

**Date**: 2026-11-06 | **Spec**: [spec.md](./spec.md)

Three read-only surveys of the code base: multi-domain hosting and auth, the organization data model and isolation touchpoints, and public-page routing. File paths are relative to the repository root.

## R1. What is left of upstream organizations

- **Decision**: rebuild on the upstream structures that are still in the schema and still read by live code. Do not resurrect the removed `packages/features/ee/organizations` or the `/org/[orgSlug]` routes.
- **Findings**:
  - Schema: `Team.isOrganization`, `Team.parentId` with `@@unique([slug, parentId])`, `Profile` (`@@unique([username, organizationId])`), `OrganizationSettings`, `User.organizationId` with `@@unique([username, organizationId])`, `Membership` (roles MEMBER/ADMIN/OWNER), `TempOrgRedirect` (`from`, `fromOrgId`, `type`, `toUrl`, `enabled`).
  - Loaders still take org parameters but every caller hard-codes `currentOrgDomain = null; isValidOrgDomain = false`:
    - `apps/web/server/lib/[user]/getServerSideProps.ts:79`
    - `apps/web/server/lib/[user]/[type]/getServerSideProps.ts:127,226`
    - `apps/web/lib/d/[link]/[slug]/getServerSideProps.tsx:26`
    - `apps/web/app/api/username/route.ts:22`
    - `packages/features/bookings/lib/handleNewBooking/loadUsers.ts:15`
  - `UserRepository.findUsersByUsername({ orgSlug })` and `getPublicEvent` are already org-aware.
  - `getBookerBaseUrl` / `getBookerBaseUrlSync` are copied as stubs returning `WEBAPP_URL` in 7 places:
    - `packages/features/CalendarEventBuilder.ts:27`
    - `packages/features/eventtypes/lib/getEventTypesByViewer.ts:24`
    - `packages/features/eventtypes/lib/getPublicEvent.ts:41`
    - `packages/features/eventtypes/lib/getEventTypeById.ts:23`
    - `packages/features/bookings/lib/payment/getBooking.ts:18`
    - `packages/trpc/server/routers/viewer/eventTypes/utils/transformUtils.ts:7`
    - `packages/platform/libraries/organizations.ts:5`

    `packages/features/tasker/tasks/crm/lib/buildCalendarEvent.ts:62` hard-codes `WEBAPP_URL`.
  - Dead code:
    - `packages/lib/domainManager/organization.ts` calls `subdomainSuffix`, which is not imported.
    - `packages/features/profile/lib/createAProfileForAnExistingUser.ts` has a missing import and no callers.
    - `UserRepository.findManyByOrganization` is unused.
    - The subdomain rewrites in `apps/web/next.config.ts:146-330,462-500` plus `apps/web/getNextjsOrgRewriteConfig.ts` target the removed `/org/[orgSlug]` routes and only switch on with `ORGANIZATIONS_ENABLED`.
- **Alternatives considered**:
  - A brand-new `Organization` model: rejected. It duplicates `Team`, `Membership` and `Profile`, which live code (session `upId`, `ProfileRepository`, `getPublicEvent`) already understands.

## R2. Where the organization's domain is stored

- **Decision**: add `customDomain String? @unique` to `OrganizationSettings`, lowercase and without a port. The default organization is the one whose `customDomain` equals the host of `NEXT_PUBLIC_WEBAPP_URL`, which is `cal.bluebee.marketing`. No "is default" column is needed.
- **Rationale**: there is nothing in the schema that can hold a host. Upstream derived `<slug>.<suffix>` and never stored a domain. `OrganizationSettings` is already 1:1 with an organization.
- **Alternatives considered**:
  - A `Team.customDomain` column: it would be nullable and meaningless for 99% of team rows.
  - A separate `OrganizationDomain` table for several domains per org: speculative (constitution V).
  - An `isDefault` flag: needs a partial unique index and can drift from the configured app URL.

## R3. Membership representation

- **Decision**: a user's organization is represented exactly as upstream did. Everything uses the existing columns.
  - `User.organizationId = orgId`.
  - One `Profile` row (`userId`, `organizationId`, `username`).
  - One accepted `Membership` on the organization team, carrying the org role (OWNER/ADMIN/MEMBER).
  - A top-level team of the org has `parentId = orgId`.
- **Rationale**: it gives per-org username and slug uniqueness through the existing unique constraints, and keeps `ProfileRepository` and the session's profile handling working. An `OrganizationMembershipService` keeps the three rows in sync, inside one transaction.
- **Constraint enforcement**: Postgres treats NULLs as distinct, so `@@unique([username, organizationId])` does not protect users without an org. The final migration (PR 23) sets `User.organizationId NOT NULL` after the switch-over. Until then the services reject a user without an organization.

## R4. Resolving the request's organization

- **Decision**: `apps/web/proxy.ts` resolves `Host` to an organization and sets the trusted request headers `x-cal-org-id` and `x-cal-org-slug`. It first deletes any client-supplied copies. Server code reads the org through one helper, `getOrgFromRequest(headers)`. That helper re-resolves from `Host` when the headers are absent.
- **Resolution details**:
  - The resolver `OrganizationDomainResolver` lives in `packages/features/organizations` and caches host → org in memory for 60 seconds.
  - Loopback hosts (`localhost`, `127.0.0.1`, any port) resolve to the default organization. This keeps the deploy health check `127.0.0.1:<port>/api/version` and local development working.
  - An unknown host gets a plain 404 from the proxy, with no organization content (FR-016).
- **Rationale**: `proxy.ts` runs on the Node runtime in Next 16 (no `runtime` export), so a database lookup is possible. Headers already reach page loaders through `buildLegacyCtx`.
  - `/api/book/event`, tRPC and API v2 are not on the proxy matcher or are not host-bound, so the helper's `Host` fallback covers them.
  - API v2 calls are not tied to a domain. They keep resolving the org from the request body (`orgSlug` / `organizationSlug`), and the shared services enforce consistency.
- **Alternatives considered**:
  - Static `next.config` `has: host` rewrites: they need a rebuild for every new domain and cannot read the database.
  - Per-page host parsing only: it duplicates the resolution in about 15 loaders and risks one being missed.

## R5. One app serving several domains: links

- **Decision**: build a "base URL of a subject" service and route every link through it. Fix the hot spots first, then sweep.
  - Server: `OrganizationUrlService.getBaseUrl({ orgId })` returns `https://<customDomain>`. When the org has no domain, or for loopback, it falls back to `WEBAPP_URL`.
  - It replaces the 7 `getBookerBaseUrl` stubs with one implementation and sets `CalendarEvent.bookerUrl` from the organizer's org. That covers cancel, reschedule and manage links in booking emails, ICS files and webhook payloads (`packages/lib/CalEventParser.ts:243,312`).
  - Client: the root layout reads `x-cal-org-*` and provides `OrgBaseUrlContext`. `useBookerUrl` / `useEmbedBookerUrl` and the client components that build absolute URLs from `NEXT_PUBLIC_WEBAPP_URL` read the context instead. That is about 65 client files; `window.location.origin` is acceptable where the current host is by definition right.
  - Background jobs (emails, reminders, workflows, crons, tasker) have no request. They resolve the org from the subject (organizer, team, user) through the service, never from a host.
- **Scale**:
  - About 223 non-test files reference `WEBAPP_URL`, `WEBSITE_URL`, `CAL_URL` or `NEXT_PUBLIC_WEBAPP_URL`.
  - About 70 of them carry user-facing links that would be wrong on another domain: auth, booking links, emails, OAuth.
  - The rest are internal (API base for server-to-server calls, CSP, SEO defaults) and can stay on the default domain.
  - The sweep is split by area into PRs under 10 files each (see plan.md).
- **Alternatives considered**:
  - Setting `NEXT_PUBLIC_WEBAPP_URL` per domain: it is inlined at build time, so it would need one build per domain.
  - Running three app instances: rejected. It triples memory and deploy time and breaks the "one instance, instance admins see all orgs" model.

## R6. Sign-in across domains

- **Decision**: per-domain sessions.
  - Keep `NEXTAUTH_COOKIE_DOMAIN` empty, so cookies stay host-only. That already gives one session per domain.
  - Set `AUTH_TRUST_HOST=true` (next-auth 4.24.13 then derives the base URL from `X-Forwarded-Host` / `Host`; Caddy forwards both).
  - Allow the `redirect` callback (`packages/features/auth/lib/next-auth-options.ts:1164`) and `getSafeRedirectUrl` to target any organization domain.
  - In the `signIn` callback, reject a user whose organization differs from the host's organization, and send them to their own domain's login (FR-017).
  - Stop `sendVerificationRequest.ts:21` rewriting magic links to `NEXTAUTH_URL`.
  - In the JWT, set `org.fullDomain` (`next-auth-options.ts:521`) from the user's org.
- **Owner action**: Google and Azure AD sign-in callbacks become `<domain>/api/auth/callback/<provider>`, which must be registered with each provider, for each domain, if those sign-in providers are enabled.
- **Alternatives considered**:
  - A cookie shared across domains: impossible across registrable domains (`bespokesoft.pl` and `bluebee.marketing`).
  - A central login domain with token hand-off: more moving parts, and the spec already accepts per-domain sessions.

## R7. Calendar and video app connections (OAuth)

- **Decision**: build `redirect_uri` from the request's organization domain instead of `WEBAPP_URL_FOR_OAUTH`, and have the owner register each domain's callback with every provider in use.
  - The callback must run on the same domain the user is signed in on: `decodeOAuthState` verifies an HMAC nonce against `req.session` (`packages/app-store/_utils/oauth/decodeOAuthState.ts:22-32`).
  - After the callback, `getSafeRedirectUrl` must accept the organization domains.
- **Rationale**: the spec's earlier default of bouncing through `cal.bluebee.marketing` cannot work, because the session does not exist on the bounce domain. The spec assumption is corrected accordingly.
- **Scale**: about 25 app folders build `redirect_uri` the same way. They will go through one helper `getOAuthRedirectUri(req, appSlug)`, as a mechanical sweep. Only apps enabled on this instance need provider registrations; quickstart lists how to find them.

## R8. Isolation touchpoints

Every non-admin path that lists, searches or mutates users or teams across the instance:

| Area | Today | Change |
|------|-------|--------|
| `viewer.teams.create` / `isSlugAvailable` (`TeamCreationService.ts:47-54`) | global slug check, no `parentId` | set `parentId = caller org`; check slug within the org |
| `viewer.teams.inviteMember` (`TeamMembersService.ts:155`, `UserRepository.findInviteeByEmail:278`) | global user lookup; new users created with no org | look up only within the caller's org; refuse members of another org; create new users in the team's org |
| Public team lookup (`TeamProfileService.ts:211-216`) | `findFirst({ slug })`, ambiguous across orgs | add `parentId = host org` |
| Teams list page (`apps/web/app/(use-page-wrapper)/(main-nav)/teams/page.tsx:21`) | lists the org team too | filter `isOrganization` |
| Event-type hosts, availability, OOO (`EventTypeHostService`, `listTeamAvailability.handler.ts`, `outOfOfficeCreateOrUpdate`) | scoped by team membership | safe once teams are org-bound; add org assertion in the host-assignment service |
| Notetaker sharing, webhooks, apps for teams | team-membership based | safe once teams are org-bound; no change beyond tests |
| Username checks (`checkRegularUsername`, `lib/server/username.ts`, `features/auth/signup/username.ts`, `/api/username`) | global unless an org slug is passed | always pass the subject's org |
| Signup (`selfHostedHandler.ts:169`) | `organizationId: null` | host org for invitation-less sign-up (FR-013, default org on the default domain); token's team org otherwise |
| `teamsAndUserProfilesQuery`, `TeamsFilter`, `memberMeetings` | already filter `isOrganization` | keep |

## R9. Redirects after moves

- **Decision**: reuse `TempOrgRedirect` with `fromOrgId = old org id`, `type` (User, Team, UserEventType, TeamEventType), `toUrl` = absolute URL on the new domain, and `enabled`.
  - Rewrite `apps/web/lib/handleOrgRedirect.ts`: look up by the host org, honour `enabled`, return `permanent: true`, and drop the `?orgRedirection=true` loop guard. Cross-domain targets cannot loop, because the redirect is keyed on the old org.
  - Add the same handling to the team loaders.
  - Disable (`enabled = false`) a redirect when the freed username or slug is taken again in the old org (spec US5-6).
- **Alternatives considered**: a new redirect table. Rejected, because `TempOrgRedirect` already has the needed shape and the right unique key (`from`, `type`, `fromOrgId`).

## R10. Embeds

- **Decision**: generated snippets always emit `calOrigin` = the event owner's org domain (`packages/features/embed/lib/EmbedCodes.tsx:11`, `useEmbedBookerUrl`). Existing snippets without `calOrigin` keep pointing at the default domain; for users moved out of BlueBee, the redirect then carries them over (R9).

## R11. Feature switch and the old subdomain rewrites

- **Decision**: delete the dead upstream subdomain rewrite config:
  - `apps/web/getNextjsOrgRewriteConfig.ts`
  - the `isOrganizationsEnabled` blocks in `apps/web/next.config.ts`

  Then reuse `ORGANIZATIONS_ENABLED` as the switch for host-based resolution and sign-in enforcement. With the switch off, the proxy resolves every host to the default organization and no host check runs, so behaviour is identical to today.
- **Owner approval needed**: deleting files (constitution).

## R12. Unknowns resolved

| Unknown | Resolution |
|---------|------------|
| Does next-auth v4 support several hosts at runtime? | Yes, with `AUTH_TRUST_HOST=true` (R6). |
| Can OAuth app callbacks stay on the default domain? | No (R7). Per-domain registration is needed. |
| Where to store domains? | `OrganizationSettings.customDomain` (R2). |
| How to keep the deploy health check working when unknown hosts are refused? | Loopback hosts resolve to the default org (R4). |
| Does Caddy forward the host? | `reverse_proxy` forwards `Host` and sets `X-Forwarded-Host` / `X-Forwarded-Proto` by default. |
