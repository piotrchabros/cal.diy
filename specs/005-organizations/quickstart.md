# Quickstart: validating Organizations

Run everything against a **scratch database**, never the `.env` database (that one is live production). Use a separate worktree, e.g. `/root/cal.diy-dev`, with its own `.env` whose `DATABASE_URL` points at a scratch Postgres seeded with `yarn workspace @calcom/prisma db-seed`.

## 0. Find the OAuth apps in use (for the owner checklist)

Run this read-only query against production, done by the owner:

```sql
SELECT "appId", count(*) FROM "Credential" WHERE "appId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
```

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

1. Merge all PRs. The flag is off, so behaviour is unchanged.
2. `db-deploy` PR 1 and PR 22 migrations, then deploy.
3. Do the steps in [contracts/infra-owner-checklist.md](./contracts/infra-owner-checklist.md).
4. Set the env and deploy.
5. Create BespokeSoft and JellyMatch, then move their people (S2, S4).
6. After a week without issues, apply PR 23 (`organizationId NOT NULL`).
