# PLAN — Teams: create team flow (#3)

Tracking plan: `.ai/runs/2026-10-04-teams-create-team-flow/PLAN.md`
Issue: #3 (part of Epic #1) · Base: `develop` · Branch: `feat/teams-create-team-flow`
Bar (gauntlet-loop): `teams/create a team.png` =
https://raw.githubusercontent.com/piotrchabros/cal.diy/qa-evidence-teams/teams-evidence/create-a-team.png

## Tasks

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 0 | 0.1 | Run folder + plan, draft PR early with Fixes #3 | inline | done | docs(runs): add execution plan for teams-create-team-flow |
| 1 | 1.1 | TeamCreationService (service-layer logic, ErrorWithCode, select) + unit tests | inline | done | feat(teams): add TeamCreationService with slug validation |
| 1 | 1.2 | tRPC viewer.teams router (create + isSlugAvailable) + register in viewer/_router | inline | done | feat(teams): add viewer.teams create/isSlugAvailable endpoints |
| 2 | 2.1 | i18n strings for create-team flow | inline | done | feat(teams): add create-team i18n strings |
| 2 | 2.2 | teams/new page.tsx (permission check) + CreateTeamForm client component + preview | inline | done | feat(teams): add teams/new create-team form page |
| 2 | 2.3 | TeamPublicPreview panel + live validation wiring (slug check, logo rules) | inline | done | feat(teams): wire live slug and logo validation |
| 2 | 2.4 | Biome format/autofix pass over new files | inline | done | style(teams): apply Biome autofixes to create-team files |
| 3 | 3.1 | Gauntlet-loop UI polish vs bar (builder + harsh critic, blind A/B) | inline | done | feat(teams): polish create-team UI to match reference bar |
| 3 | 3.2 | Final gate (type-check, lint, tests) + review fixes | inline | todo | test(teams): final gate fixes for create-team flow |

## Goal

User can create a team (logo, name, unique URL slug, bio) from a dedicated form with a
live public-page preview, matching the reference screenshot at the same viewport.
On success, route to the new team's public page (`/team/{slug}`).

## Scope

- `POST`-equivalent tRPC `viewer.teams.create` (name/slug/bio/logoUrl) + `isSlugAvailable`
  uniqueness query; slug normalization via `@calcom/lib/slugify`.
- Service layer `packages/features/teams/services/TeamCreationService.ts` holds business
  logic; Prisma queries use `select` (never `include`, never `credential.key`).
- `ErrorWithCode` in service; `TRPCError` only in the router.
- Route `apps/web/app/(use-page-wrapper)/teams/new/page.tsx` — server component with
  `getServerSession` permission check + redirect (never in layout).
- Client form: logo upload (type/size validation, 5 MB max, 64x64 hint), name input,
  slug input with `cal.eu/team/` prefix + live uniqueness check, bio textarea,
  Cancel + Continue (disabled until valid), error/loading states.
- Preview panel (browser mock): team name, bio, 5 sample event types with Book now buttons.
- i18n: all UI strings via `packages/i18n/locales/en/common.json`.

## Non-goals (siblings own them; follow-ups → NEW issues)

- #2 list page / sidebar nav / team cards — no `/teams` list surface here.
- #4 members management (roles, invites) — create adds creator as OWNER only.
- #5 profile settings / danger zone — no edit surface here.
- Real avatar upload pipeline (CDN/S3) — logo accepted as URL + local file validation +
  client-side preview; server upload endpoint is a follow-up if needed.
- Organizations, sub-teams, billing.

## Risks

- `viewer._router` registration conflicts with sibling branches — small, isolated addition.
- gh CLI is 2.45.0 (predates 2.82.1): label/title mutations use REST API per tracker descriptor.
