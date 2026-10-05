# Plan — Public team page (/team/[slug]) — Fixes #14

Subject issue: piotrchabros/cal.diy#14 (OPEN, feature, priority-high).
Base: `develop`. Branch: `feat/14-public-team-page`. Worktree: `/tmp/opencode/wt-public-team-page`.

## Goal

Build the public team page at `/team/[slug]`: team profile header (logo, name, bio,
location, socials), event-type list with durations + "Book now" buttons routing to
`/team/[slug]/[eventSlug]`, 404 for unknown slugs, loading/error states, SEO metadata.
Public-safe `select` only — never expose `credential.key` or private fields.

## Bar (gauntlet-loop, MANDATORY for UI)

`teams/create a team.png` right-hand preview (public page mock with event list).
Builder + SEPARATE harsh critic, blind A/B at same viewport, loop until critic picks ours.

## Scope / Non-goals

- IN: route + view + public service getter + i18n + tests + metadata.
- OUT (follow-ups → NEW issues): `/team/[slug]/[eventSlug]` booker route (verify whether it
  exists; if not, file issue), private-team gating refinements, org handling.

## Tasks

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 0 | 0.1 | Run folder + draft PR + claim | inline | done | — |
| 1 | 1.1 | `getPublicTeamBySlug` in TeamProfileService + unit tests | inline | todo | — |
| 2 | 2.1 | `/team/[slug]` route: page, view, loading/error, metadata, i18n | inline | todo | — |
| 3 | 3.1 | Gauntlet critic pass vs mock + fixes | inline | todo | — |
| 4 | 4.1 | Final gate + review + merge + verify #14 closed | inline | todo | — |

## Risks

- `/team/[slug]/[eventSlug]` booker may not exist → Book-now target dead → file follow-up.
- `[user]` catch-all vs `team/[slug]` precedence: concrete segment wins; verify no rewrite conflict.
- Deep `@calcom/ui` imports break prod build → entrypoint imports only.
