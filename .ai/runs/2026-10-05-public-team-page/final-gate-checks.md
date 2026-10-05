# Final gate — Public team page (#14)

Date: 2026-10-05T07:45Z. Branch `feat/14-public-team-page`, 3 commits.

## Validation (config `validation.commands`, real worktree install)

- `yarn type-check:ci --force` — 9/9 tasks successful (includes @calcom/web + @calcom/features).
- `yarn lint` — 11/11 tasks successful.
- `TZ=UTC yarn test` — 4164 passed, 47 skipped, 3 todo; 1 failed in
  `apps/web/modules/users/views/users-public-view.test.tsx` (timer-related, untouched by
  this diff) — passes in isolation on re-run. Verdict: flaky, unrelated.

## Scope checks

- Public-safe `select` only (no `credentials`, no `members`, hidden events excluded,
  private teams return null). Verified by unit test asserting select shape.
- Entrypoint UI imports only (`@calcom/ui/components/*`); no deep form paths.
- `import type` for types; no `as any`; i18n reused existing keys (no new strings needed).
- 404 for unknown/empty/malformed slugs; loading.tsx + error.tsx; SEO metadata via
  `_generateMetadataForStaticPage`.

## Gauntlet (UI bar: teams/create a team.png right-hand preview)

- Structural comparison builder-vs-mock: header (name/bio), event rows
  (title + duration pill + description + Book now →), dividers — all match.
- Deviations justified by issue spec / app design system: logo avatar, location, socials,
  separate header/list cards (matches `[user]` public pages).
- 1 critic fix applied: malformed slugs → 404 instead of 500.
- Limit: no live-viewport screenshots (no browser provider in this environment).

## Follow-up (out of #14 scope → NEW issue)

- `/team/[slug]/[eventSlug]` team event booker route does not exist; Book now buttons
  target that cal.com-parity URL. File issue after merge.
