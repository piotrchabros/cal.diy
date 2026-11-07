# Quickstart: validating Organizations

Run everything against a **scratch database**, never the `.env` database (that one is live production). Use a separate worktree, e.g. `/root/cal.diy-dev`, with its own `.env` whose `DATABASE_URL` points at a scratch Postgres seeded with `yarn workspace @calcom/prisma db-seed`.

## 0. Find the OAuth apps in use (for the owner checklist)

The code side is done: every OAuth app in the app store builds its callback from the request's organization domain, and [contracts/infra-owner-checklist.md](./contracts/infra-owner-checklist.md) lists each app's callback path (Alby included). Which of them this instance actually uses is only known from production, so the owner runs this read-only query there (agents never connect to production):

```sql
SELECT "appId", count(*) FROM "Credential" WHERE "appId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
SELECT slug FROM "App" WHERE enabled ORDER BY 1;
```

Register the per-domain callbacks only for the apps these return.

## 1. Unit suites

```bash
TZ=UTC yarn vitest run packages/features/organizations
TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/admin/organizations packages/trpc/server/routers/viewer/organization
TZ=UTC yarn vitest run packages/features/membership packages/features/profile packages/lib/server/username
TZ=UTC yarn vitest run apps/web/lib/handleOrgRedirect apps/web/server/lib
```

Expected: all pass. Coverage of the new and changed code is at least 80%.

## 2. Local multi-domain setup (scratch)

1. Add these to `/etc/hosts` (as new lines, leaving existing ones alone): `127.0.0.2 bluebee.test bespoke.test jelly.test unknown.test`.
2. Start a disposable Postgres (no volume), e.g. `docker run -d --name caldiy-e2e-pg -e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=calcom_e2e -p 127.0.0.1:5547:5432 postgres:16-alpine`, and for S2's invitation email a mail catcher: `docker run -d --name caldiy-e2e-mailhog -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 mailhog/mailhog`.
3. Write a separate env file for the worktree (never copy the production `.env`; generate fresh `NEXTAUTH_SECRET` / `CALENDSO_ENCRYPTION_KEY`) with `DATABASE_URL`/`DATABASE_DIRECT_URL` pointing at the scratch container, `NEXT_PUBLIC_WEBAPP_URL=http://bluebee.test:<port>`, `NEXTAUTH_URL=http://bluebee.test:<port>/api/auth`, `ORGANIZATIONS_ENABLED=1`, `AUTH_TRUST_HOST=true`, `ALLOWED_HOSTNAMES` listing the three hosts (with and without the port), `ALLOWED_DEV_ORIGINS=bluebee.test,bespoke.test,jelly.test,unknown.test` (without it `next dev` blocks HMR on those hosts and pages reload in a loop), `EMAIL_SERVER_HOST=127.0.0.1`, `EMAIL_SERVER_PORT=1025`, `E2E_TEST_MAILHOG_ENABLED=1` and `NEXT_PUBLIC_IS_E2E=1`. Load it with `set -a && . ./.env.e2e && set +a` before every command below. Pick a free port; 3221/3222 serve production.
4. Apply the migrations to scratch: `cd packages/prisma && npx prisma migrate deploy`. This includes PR 1 and the switch-over from PR 22. Check that the printed counts match.
5. Seed: `yarn workspace @calcom/prisma db-seed`. The seed runs after the switch-over, so re-run the repeat-safe switch-over SQL (`packages/prisma/migrations/20261107000100_organizations_bluebee_switchover/migration.sql`) with `psql` to put the seeded users and teams into BlueBee, then point BlueBee at the local domain: `UPDATE "OrganizationSettings" SET "customDomain"='bluebee.test' WHERE "organizationId"=(SELECT id FROM "Team" WHERE slug='bluebee' AND "isOrganization");`.
6. Start the app: `cd apps/web && node scripts/copy-app-store-static.js && npx next dev --turbopack -p <port> -H 0.0.0.0` (not `next build`). If deep `/settings/...` routes answer 404 after a compile error, stop the server and delete `apps/web/.next/dev` (stale Turbopack routes).

## 3. Scenarios

| # | Steps | Expected |
|---|-------|----------|
| S1 (US6) | After step 2.3, open `http://bluebee.test:3000/<existing username>` and sign in as an existing user | Works as before; the user is in BlueBee |
| S2 (US1) | As instance admin: Settings → Admin → Organizations → create "BespokeSoft", slug `bespokesoft`, domain `bespoke.test`, owner = invite `owner@bespoke.test` | Listed; invitation link points at `http://bespoke.test:3000` |
| S3 (US1) | Repeat with slug `bespokesoft` or domain `bespoke.test` | Refused with "slug taken" / "domain taken" |
| S4 (US5) | Move user `jan` and team `sales` from BlueBee to BespokeSoft | `http://bespoke.test:3000/jan` and `/team/sales` work; `http://bluebee.test:3000/jan` → 308/301 to bespoke.test; Jan's bookings are kept |
| S5 (US3) | As Jan, sign in on `bluebee.test` | Sent to `bespoke.test` login; signing in there works; no session on `bluebee.test` |
| S6 (US2) | Create user `jan` in JellyMatch (`jelly.test`); as BespokeSoft's team admin invite Jelly's Jan's email | Refused: "belongs to another organization" |
| S7 (US2) | As a BespokeSoft member call `viewer.teams.get` with a JellyMatch team id | NOT_FOUND |
| S8 (US3) | Book Jan on `bespoke.test`; check the confirmation email, the ICS and the webhook payload | All links use `http://bespoke.test:3000` |
| S9 (US3) | Open `http://unknown.test:3000/` (add it to hosts) | 404, no content |
| S10 | `curl http://127.0.0.1:3000/api/version` | 200 (loopback → default org) |
| S11 (US4) | As BespokeSoft owner: invite, promote to admin, remove a member, delete a team; try to demote the last owner | All work except the last-owner demotion (refused); the removed member is now in BlueBee |
| S12 (US1) | Delete BespokeSoft while it has members; delete BlueBee | Both refused |
| S13 | Turn `ORGANIZATIONS_ENABLED` off and restart | Behaviour on `bluebee.test` is identical to today |

## 4. E2E (scratch only; asks for the owner's go-ahead per constitution)

`apps/web/playwright/organizations.e2e.ts` covers S2, S4, S5 and S6 against the scratch setup (it skips unless `ORGANIZATIONS_ENABLED` is set and `NEXT_PUBLIC_WEBAPP_URL` is on `bluebee.test`, so CI never runs it). With the dev server from §2 running and the env file loaded: `PLAYWRIGHT_HEADLESS=1 yarn e2e apps/web/playwright/organizations.e2e.ts --workers=1`. The spec creates its own users and teams with a random suffix and removes them (and the BespokeSoft/JellyMatch organizations on `bespoke.test` / `jelly.test`) before and after the run, so it can be repeated. S4 checks the moved team's old link by following it in the browser because it redirects client-side today (T350).

## Results (T073, 2026-11-07)

Run on the scratch setup from §2 (`caldiy-e2e-pg` on 127.0.0.1:5547, develop at `a38c722d` including the T062 `organizationId NOT NULL` migration, `next dev` on port 3747, `NEXT_PUBLIC_WEBAPP_URL=http://bluebee.test:3747`). S2, S4, S5 and S6 ran through `apps/web/playwright/organizations.e2e.ts` (4/4 passed). The other scenarios were checked with a temporary Playwright script (browser sign-in plus tRPC calls made with the signed-in session, the same calls the settings pages make) and `curl`.

| # | Expected | Actual | Result |
|---|----------|--------|--------|
| S1 | Existing user's page and sign-in work; user is in BlueBee | `bluebee.test/pro` 200; `pro@example.com` signs in, session OK; `pro.organizationId` = BlueBee | Pass |
| S2 | BespokeSoft listed; invitation link on `bespoke.test` | Listed with domain `bespoke.test`; owner has a pending OWNER membership; the invite email links to `http://bespoke.test:3747/auth/team-invite?token=…` | Pass |
| S3 | Duplicate slug / domain refused | Same slug: CONFLICT "Organization slug is already taken". Same domain: CONFLICT "Organization domain is already taken". Invalid host: BAD_REQUEST "Organization domain must be a valid hostname" | Pass |
| S4 | Moved user and team pages work on `bespoke.test`; old links 308/301; bookings kept | `bespoke.test/jan-…` and `/team/sales-…` 200; `bluebee.test/jan-…` and `bluebee.test/team/sales-…` answer 301/308 to the same path on `bespoke.test` (server-side since T350); booking still Jan's | Pass |
| S5 | Jan on `bluebee.test` is sent to `bespoke.test` login; no session on `bluebee.test` | Sent to `bespoke.test/auth/login?reason=wrong_organization_domain`; signing in there works; `bluebee.test/api/auth/session` has no user | Pass |
| S6 | Inviting JellyMatch's Jan refused | Toast "This person belongs to another organization"; no membership created | Pass |
| S7 | `viewer.teams.get` with a JellyMatch team id → NOT_FOUND | NOT_FOUND "Team not found" | Pass |
| S8 | Confirmation email, ICS and webhook links use `bespoke.test` | Booking made on `bespoke.test/jan-…/30min`; success page on `bespoke.test`; ICS and BOOKING_CREATED webhook payload use only `http://bespoke.test:3747`; both emails link to `bespoke.test`, **except** the shared footer logo link (`href="http://bluebee.test:3747"`) and image assets, which use WEBAPP_URL | Pass with a gap (T353) |
| S9 | `unknown.test` → 404, no content | 404 `Not Found` (plain text) | Pass |
| S10 | `127.0.0.1/api/version` → 200 | 200 | Pass |
| S11 | Owner can invite, promote, remove, delete a team; last-owner demotion refused; removed member in BlueBee | invite, promote to ADMIN, remove, delete team: all OK; removed member's organization = BlueBee; demoting the last owner: PRECONDITION_FAILED "An organization must keep at least one owner" | Pass |
| S12 | Deleting BespokeSoft (with members) and BlueBee refused | PRECONDITION_FAILED "Move the organization's members and teams out before deleting it" / "The default organization cannot be deleted"; both still exist | Pass |
| S13 | Flag off: behaviour on `bluebee.test` identical to today | Restarted without `ORGANIZATIONS_ENABLED`/`AUTH_TRUST_HOST`: `/pro`, `/pro/30min`, `/team/seeded-team`, `/auth/login` 200; `/api/version` 200; `pro` and `admin` sign in with no `org` in the session; `/event-types`, profile and admin users pages work; `/settings/admin/organizations` 404; any host is served (no organization lookup) | Pass |

Notes from the run:

- After deleting an organization and recreating one on the same domain, the domain resolver keeps the old organization id for up to 60 seconds (`ORGANIZATION_DOMAIN_CACHE_TTL_MS`). Bookings on that domain fail with `event_not_found` until it expires. Test scripts that recreate organizations must wait it out. In production a domain only moves between organizations through an edit, where up to 60 seconds of staleness is acceptable.
- With the scratch setup's default Daily video location (no API key), the booking still succeeds but only the organizer's "[Action Required]" email is sent. S8 used an in-person location.

## 5. Production rollout (owner)

Production behaviour stays unchanged until step 5: every behaviour change is behind `ORGANIZATIONS_ENABLED`, and the migrations are applied by the owner, never by the deploy script.

**From now on, every deploy of `develop` must be preceded by `yarn workspace @calcom/prisma db-deploy`** (after a database backup). The T062 stack is merged (owner decision 2026-11-07: #371, #372, #373): new users always get the default organization and the schema has `User.organizationId` NOT NULL. `db-deploy` applies T061 (BlueBee switch-over) and then T062 (`20261107000200_user_organization_required`), which aborts, leaving the database untouched, if any user is still without an organization.

1. **Merge** all PRs into `develop`. The flag is off, so behaviour is unchanged. Make sure the deployed release contains the T221 change (flag-off user and team lookups ignore the organization, PR #297) before step 3.
2. **Inventory**: run the step 0 query on production and note the OAuth apps in use.
3. **Migrations, then deploy** (`yarn workspace @calcom/prisma db-deploy`, after a database backup, then `/root/caldiy-deploy.sh`). `db-deploy` applies, in order:
   1. PR 1 (`customDomain` on organizations), if still pending.
   2. T061 / PR 22, the BlueBee switch-over (`20261107000100_organizations_bluebee_switchover`). It is repeat-safe; compare the printed counts with the number of users and teams. Public booking pages keep working because of T221 (spot-check a few `cal.bluebee.marketing/<username>` links, SC-004).
   3. T062 / PR 23 (`20261107000200_user_organization_required`, `organizationId NOT NULL`, FK `ON DELETE RESTRICT`).
   Every later deploy of `develop` repeats this: `db-deploy` first (a no-op when nothing is pending), then the deploy.
4. **Infrastructure**: do every row of [contracts/infra-owner-checklist.md](./contracts/infra-owner-checklist.md): DNS, Caddy, `ALLOWED_HOSTNAMES`, OAuth callbacks per domain (including Alby if used), forwarded headers and closed Node ports.
5. **Env**: in `/root/cal.diy/.env` set `ORGANIZATIONS_ENABLED=1` and `AUTH_TRUST_HOST=true` together (never one without the other), keep `NEXTAUTH_COOKIE_DOMAIN` empty, then deploy.
6. **Verify on production**: S1 (existing users sign in and their pages work), S9 (unknown host 404), S10 (`/api/version` 200), and S13's rollback path in mind: turning the flag off means removing both `ORGANIZATIONS_ENABLED` and `AUTH_TRUST_HOST` and redeploying.
7. **Populate**: create BespokeSoft and JellyMatch with their domains (S2), then move their people and teams (S4). After the first move, do the 308 `curl -sI` check from the checklist's "Move redirects" section.

Rollback: unset both env variables and redeploy. The T061 data and the T062 constraint stay in place and are harmless with the flag off (T221); do not roll the migrations back, since the code on `develop` requires them.
