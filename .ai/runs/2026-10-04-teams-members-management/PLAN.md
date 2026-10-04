# PLAN — Teams members management (issue #4)

Tracking plan: `.ai/runs/2026-10-04-teams-members-management/PLAN.md`
Issue: #4 — "Teams: members management (roles, invites, search/filter)" (part of Epic #1)
Base: `develop` → branch `feat/teams-members-management`

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids and `Exec` cells are immutable once the plan is committed — per-Step commits touch only `Status` and `Commit`.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | TeamMembers service + repository methods + unit tests | inline | done | — |
| 1 | 1.2 | tRPC teams router: get + listMembers, wired into viewer router | inline | todo | — |
| 1 | 1.3 | tRPC mutations: invite, updateRole, remove, resendInvite + tests | inline | todo | — |
| 2 | 2.1 | Members page.tsx (server, permission-gated) + client shell states | inline | todo | — |
| 2 | 2.2 | Toolbar (search/filter/display) + table + badges + pagination | inline | todo | — |
| 2 | 2.3 | Invite dialog + row actions (role change/remove/resend) | inline | todo | — |
| 2 | 2.4 | Sidebar My-teams nav + i18n strings | inline | todo | — |
| 3 | 3.1 | Gauntlet UI pass vs reference bar (harsh critic + fixes) | inline | todo | — |
| 3 | 3.2 | Final gate + review fixes | inline | todo | — |

## Goal

As a team owner/admin, view, invite, search, filter and manage team members and roles from
`Team members` settings page matching the reference bar
(`teams/team members.png`, also at
https://raw.githubusercontent.com/piotrchabros/cal.diy/qa-evidence-teams/teams-evidence/team-members.png).

## Scope

- tRPC `viewer.teams` router: `get` (team header info), `listMembers`
  (search + role filter + pagination, `select`-only), `inviteMember`,
  `updateRole`, `removeMember`, `resendInvite`. Owner/admin-gated mutations
  (`TRPCError` in routers; `ErrorWithCode` in service).
- Business logic in `TeamMembersService` (`packages/features/membership/services/`),
  data access in `MembershipRepository` (+ small `TeamRepository` read where needed).
- UI route `settings/teams/[id]/members`: `page.tsx` permission check (owner/admin or
  member can view; only owner/admin mutate), client view with toolbar, table
  (checkbox, Member, Role badges Owner/Admin/Pending/Member, Last active, row actions),
  pagination footer, invite dialog, confirmations, loading/empty/error states, i18n.
- Minimal sidebar `My teams > <Team> > Members` wiring so the page is reachable
  (list page itself is #2's scope; create flow #3; profile #5 — untouched).
- Unit tests for service + handlers (mocked prisma/mailer, no DB).

## Non-goals

- Teams list page (#2), create team flow (#3), team profile settings (#5).
- Token-accept-on-signup wiring for brand-new emails (invite creates
  VerificationToken + email; membership materializes on signup → follow-up issue).
- Billing/seats enforcement, SCIM/DSYNC, custom PBAC roles UI.
- E2E suite (no browser harness in this environment).

## Risks

- Sidebar nav overlaps #2's "sidebar nav" scope: kept to the minimal entries
  needed for #4 reachability; flagged in PR body for #2 owner.
- No subagent harness in this environment: `Exec` is `inline` throughout;
  gauntlet critic is a separate fresh-context review pass by the same session,
  recorded in step 3.1 (no parallel builder/critic agents possible).
- No browser/screenshot harness: UI verified by build + static blind A/B
  against the bar; reason logged in checkpoint files.

## External References

- Bar: `teams/team members.png` in primary checkout; remote copy URL above.
- Skill: `.agents/skills/om-auto-create-pr-loop/SKILL.md` (Spec-implementation run).
- UI bar skill: `.agents/skills/gauntlet-loop/SKILL.md` (adapted: no subagents here).
- Config: `.ai/agentic.config.json`; tracker: `.ai/trackers/github.md`.
- Conventions: `AGENTS.md` (select-only, import type, direct UI imports, i18n, Biome,
  conventional commits, no `as any`, never expose `credential.key`,
  permission checks in `page.tsx`, Owner/Admin/Member + Pending roles).
