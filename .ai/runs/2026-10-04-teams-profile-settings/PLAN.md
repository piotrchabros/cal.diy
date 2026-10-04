# Plan — Teams profile settings (issue #5)

**Issue:** piotrchabros/cal.diy#5 — Teams: profile settings (logo, URL, about, location, danger zone)
**Base:** `develop` | **Branch:** `feat/5-teams-profile-settings`
**Bar (gauntlet-loop):** https://raw.githubusercontent.com/piotrchabros/cal.diy/qa-evidence-teams/teams-evidence/team-profile.png
**Mode:** Spec-implementation run (new tRPC surface + routes + UI, ~10 commits)

## Goal
Team owner/admin can edit the team's public profile (logo, name, URL slug, about, location/map, socials) and disband the team (owner-only, confirm modal), matching the reference screenshot at the same viewport.

## Non-goals (siblings own these; follow-ups → NEW issues)
- #2 teams list, #3 create-team flow, #4 members management (no member tables/invites here)
- Organizations, billing enforcement, subdomains, public team page rendering
- Sidebar gets only the minimal "My teams > team > Team profile" entry this run needs

## Tasks

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | tRPC viewer teams router: schemas + TeamProfileService (get/update/disband) + handlers | inline | done | — |
| 1 | 1.2 | TeamProfileService unit tests (permissions, slug uniqueness, owner-only disband) | inline | done | — |
| 1 | 1.3 | Wire teamsRouter into viewer _router + backend typecheck | inline | done | — |
| 2 | 2.1 | page.tsx route settings/my-teams/[id]/profile (permission checks) + skeleton/loading-error states | inline | done | — |
| 2 | 2.2 | TeamProfileView form card + i18n strings | inline | done | — |
| 2 | 2.3 | Danger zone card + Disband confirm modal (owner-only) | inline | done | — |
| 2 | 2.4 | Sidebar My-teams nav entry | inline | todo | — |
| 3 | 3.1 | Gauntlet-loop UI pass vs reference (builder + harsh critic, blind A/B) | inline | todo | — |
| 3 | 3.2 | Final gate: type-check + lint + tests, review fixes | inline | todo | — |

## Design notes
- `select` (never `include`) in Prisma queries; never expose `credential.key`.
- `import type` for types; direct `@calcom/ui/components/*` imports; Biome; conventional commits; no `as any`.
- Business logic in service/handler layer; `ErrorWithCode` in non-tRPC files.
- Permission checks in `page.tsx`, never `layout.tsx`. Team ID readonly with copy button. Slug uniqueness validated server-side. Disband: owner-only + typed confirm.
- Location stored on Team? `Team.metadata` (teamMetadataSchema) holds extras; socials/location-map flag go there unless a column fits. Verify zod-utils teamMetadataSchema during 1.1.
- Logo upload reuses `@calcom/ui/components/image-uploader`; About reuses `@calcom/ui/components/editor`.

## Risks
- Sidebar overlap with sibling issues #2/#4 (both touch "My teams" nav) → keep nav diff minimal/additive.
- No existing viewer teams router → new surface must follow authedProcedure conventions.
- UI dev-server screenshots may be unavailable in sandbox → record reason, compare statically.
