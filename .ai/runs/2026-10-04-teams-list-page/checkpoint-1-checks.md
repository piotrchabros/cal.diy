# Checkpoint 1 — implementation complete, verification green

**Timestamp (UTC):** 2026-10-04T13:45:00Z
**Steps covered:** 1.1–3.4 (all 8 commits on `feat/teams-list-page-2`)
**PR:** https://github.com/piotrchabros/cal.diy/pull/8 (draft → to be flipped ready)

## Validation run

- `TZ=UTC yarn vitest run apps/web/modules/teams/lib/teamsListUtils.test.ts` → **1 file, 8 tests passed**.
- `yarn type-check:ci --force` → **9/9 tasks successful** (after fixing `MembershipRole` import to `@calcom/prisma/enums`).
- `yarn biome lint` on touched paths → **exit 0** (warnings/infos only, nursery rules at parity with existing code).
- `yarn biome check --write` applied formatting-only changes (committed as 3.2).

## UI verification (gauntlet-loop, static — no browser tooling in this env)

- Bar inspected pixel-by-pixel (1847×1179 PNG): header + black +New; card row (black BL avatar, name, full URL, purple Owner, copy + `...` bordered group); centered tip with info icon.
- Critic pass over `teams-listing-view.tsx`: fixed mobile role-label inconsistency (3.4); remaining known delta: app shell keeps the current cal.diy nav (deliberate Non-goal, documented) instead of the screenshot's legacy cal.com sidebar.
- Live render/screenshot check: **skipped** — no browser tooling and no database/env in this environment. Recorded as the reason QA sign-off is still owed.

## Security / convention spot-check

- Prisma uses `select` only; no `include`; no `credential.key` anywhere near the query.
- `import type` for `MembershipRole` and `TeamsListTeam`; no `as any`.
- Direct `@calcom/ui/components/*` imports; no barrel imports.
- Permission check (`getServerSession` + login redirect) in `page.tsx`, not layout.
- New i18n keys added to `packages/i18n/locales/en/common.json` (`copy_team_link`, `more_options`, `teams_list_tip`).
