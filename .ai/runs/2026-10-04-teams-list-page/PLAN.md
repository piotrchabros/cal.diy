# Plan — Teams list page (issue #2)

**Issue:** piotrchabros/cal.diy#2 — "Teams: list page with sidebar nav and team cards" (part of Epic #1)
**Base:** `develop` | **Branch:** `feat/teams-list-page-2`
**Worktree:** `/root/cal.diy/.ai/tmp/om-auto-create-pr-loop/teams-list-page-20261004-151203`
**Reference bar (gauntlet-loop):** `teams/list of teams.png` (1847×1179) — fetched to `.ai/tmp/ref/list-of-teams.png` in primary checkout (reference only, not committed).

## Tasks

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | Run folder + PLAN/HANDOFF/NOTIFY | inline | done | docs(runs): add execution plan for teams-list-page |
| 2 | 2.1 | Teams entry in shell navigation | inline | todo | feat(teams): add Teams to shell navigation |
| 2 | 2.2 | Teams list route (page + loading + error) with Prisma select | inline | todo | feat(teams): add teams list page route with auth guard |
| 2 | 2.3 | Team cards UI (avatar, badge, copy, menu, tip, empty state) | inline | todo | feat(teams): add team cards listing UI |
| 3 | 3.1 | Unit tests + type-check/lint gate | inline | todo | test(teams): cover teams list helpers |

## Goal

Authenticated users get a dedicated `/teams` section (inside the existing `(main-nav)` Shell) that lists their teams as cards: avatar initials, name, public URL, role badge, copy-link, `...` menu — plus header w/ "+ New", helper tip, empty/loading/error states.

## Scope (only #2)

- `apps/web/modules/shell/navigation/Navigation.tsx`: add Teams item (`/teams`, `users` icon).
- `apps/web/app/(use-page-wrapper)/(main-nav)/teams/`: `page.tsx` (auth guard + Prisma `select` query), `loading.tsx`, `error.tsx`.
- `apps/web/modules/teams/views/teams-listing-view.tsx` (+ `lib/` helper for initials/URL): client list UI.
- i18n: reuse existing keys (`teams`, `create_manage_teams_collaborative`, `no_teams`, `no_teams_description`, `owner`, `new`, `copy_link`); add one key only if a string is truly missing.
- Tests: vitest for helpers.

## Non-goals (→ NEW issues, no scope creep)

- Team creation flow (`+ New` points at `/settings/teams/new`-equivalent; sibling agent owns create flow — link only).
- Team detail/settings pages, member management, disband/leave actions (`...` menu items beyond copy/view link out).
- Rebuilding the app sidebar to the old cal.com design in the screenshot — the current Shell nav stays; only a Teams entry is added.
- Old sidebar bottom items (View public page / Copy public page link / Settings) — already exist in current user dropdown/shell.

## Gauntlet-loop QA notes

- Bar inspected directly (PNG rendered): header, black +New, single-row card (black BL avatar, BlueBee, `https://cal.eu/team/bluebee`, purple Owner text, copy + `...` icon buttons in bordered group), centered tip line with info icon.
- Builder: implement per spec below. Critic (separate pass): compare our rendered output description vs bar, name single biggest gap, loop until ours wins. No browser tooling in this environment — verification via `next build`-safe type-check, unit tests, and static markup review; recorded as limitation in final gate.
- Judgeable pieces: (a) header + New button, (b) team card row, (c) tip line, (d) empty/loading/error states, (e) mobile stacking.

## Risks

- `yarn type-check:ci --force` is slow on this monorepo; scope `tsc` if needed but run full gate before ready.
- No dev-server screenshot capability here; rely on markup fidelity + tests.
