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

1. Add these to `/etc/hosts`: `127.0.0.2 bluebee.test bespoke.test jelly.test`.
2. In the scratch `.env`, set `NEXT_PUBLIC_WEBAPP_URL=http://bluebee.test:3000`, `ORGANIZATIONS_ENABLED=1` and `AUTH_TRUST_HOST=true`.
3. Apply the migrations to scratch: `yarn workspace @calcom/prisma db-deploy`. This includes PR 1 and the switch-over from PR 22. Check that the printed counts match.
4. Start with `yarn dev`.

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

`apps/web/playwright/organizations.e2e.ts` covers S2, S4, S5 and S6 against the scratch setup.

## 5. Production rollout (owner)

Production stays unchanged until step 6: every behaviour change is behind `ORGANIZATIONS_ENABLED`, and the migrations are applied by the owner, never by the deploy script.

1. **Merge** all PRs into `develop`. The flag is off, so behaviour is unchanged. Make sure the deployed release contains the T221 change (flag-off user and team lookups ignore the organization, PR #297) before step 3.
2. **Inventory**: run the step 0 query on production and note the OAuth apps in use.
3. **Migrations, in order** (`yarn workspace @calcom/prisma db-deploy`, after a database backup):
   1. PR 1 (`customDomain` on organizations).
   2. T061 / PR 22, the BlueBee switch-over (`20261107000100_organizations_bluebee_switchover`). It is repeat-safe; compare the printed counts with the number of users and teams. Public booking pages keep working because of T221 (spot-check a few `cal.bluebee.marketing/<username>` links, SC-004).
   3. Deploy (`/root/caldiy-deploy.sh`). T062 / PR 23 is **not** applied yet.
4. **Infrastructure**: do every row of [contracts/infra-owner-checklist.md](./contracts/infra-owner-checklist.md): DNS, Caddy, `ALLOWED_HOSTNAMES`, OAuth callbacks per domain (including Alby if used), forwarded headers and closed Node ports.
5. **Env**: in `/root/cal.diy/.env` set `ORGANIZATIONS_ENABLED=1` and `AUTH_TRUST_HOST=true` together (never one without the other), keep `NEXTAUTH_COOKIE_DOMAIN` empty, then deploy.
6. **Verify on production**: S1 (existing users sign in and their pages work), S9 (unknown host 404), S10 (`/api/version` 200), and S13's rollback path in mind: turning the flag off means removing both `ORGANIZATIONS_ENABLED` and `AUTH_TRUST_HOST` and redeploying.
7. **Populate**: create BespokeSoft and JellyMatch with their domains (S2), then move their people and teams (S4). After the first move, do the 308 `curl -sI` check from the checklist's "Move redirects" section.
8. **Finish**: after a week without issues, apply T062 / PR 23 (`organizationId NOT NULL`); its migration is written to abort if any user still has no organization.

Rollback before step 8: unset both env variables and redeploy. The T061 data stays in place and is harmless with the flag off (T221).
