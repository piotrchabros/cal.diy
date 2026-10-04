# HANDOFF — teams-create-team-flow (#3)

Run: `.ai/runs/2026-10-04-teams-create-team-flow/` · Branch: `feat/teams-create-team-flow`
Base: `develop` · Status: in-progress (Steps 0.1–2.4 done, checkpoint-1 recorded)

## Current state

- Worktree: `/root/cal.diy/.ai/tmp/om-auto-create-pr-loop/teams-create-team-flow-20261004-1515`
- Draft PR: #6 (Fixes #3), claimed (assignee + in-progress). Issue #3 claimed.
- Backend complete: `TeamCreationService` + `viewer.teams` router (create/isSlugAvailable).
- UI complete (first pass): `teams/new` page + form + preview + live validation + i18n.
- Checkpoint-1: vitest 13/13 green, biome lint exit 0. Full gate deferred to Step 3.2.

## Next action

Step 3.1 gauntlet-loop UI polish: boot dev server, screenshot harness route (UNTRACKED,
delete after), capture 1256x852, builder/critic blind A/B vs
`/tmp/opencode/create-a-team.png`, iterate, commit as 3.1. Then 3.2 final gate.

## Key decisions (unchanged)

- Route `apps/web/app/(use-page-wrapper)/teams/new/page.tsx`; success → `/team/{slug}`.
- Logo persists as data URL via FileReader (no new upload pipeline).
- Brand header uses APP_NAME ("Cal.diy"); URL prefix `cal.eu/team/` per issue text.
