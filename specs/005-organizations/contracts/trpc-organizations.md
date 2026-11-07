# Contract: tRPC organization procedures

All inputs are validated with Zod. All outputs are DTOs from `packages/lib/dto/OrganizationDto.ts`; no Prisma types cross the boundary. Errors are thrown as `ErrorWithCode` in services and converted by the tRPC middleware.

## `viewer.admin.organizations.*`: instance admins only (`authedAdminProcedure`)

| Procedure | Input | Output | Errors |
|-----------|-------|--------|--------|
| `list` | `{ search?: string, cursor?: number, limit?: 1..100 }` | `{ items: OrganizationListItemDto[], nextCursor?: number }` | |
| `get` | `{ id: number }` | `OrganizationDto` | NOT_FOUND |
| `create` | `{ name, slug, domain, owner: { userId: number } \| { email: string }, confirmMoveOwner?: boolean }` | `OrganizationDto` | CONFLICT (slug or domain taken), BAD_REQUEST (invalid slug or domain), PRECONDITION_FAILED (owner is in another org and `confirmMoveOwner` is not set) |
| `update` | `{ id, name?, slug?, domain?, ownerUserId? }` | `OrganizationDto` | NOT_FOUND, CONFLICT, BAD_REQUEST |
| `delete` | `{ id }` | `{ id }` | NOT_FOUND, PRECONDITION_FAILED (has members or teams, or is the default org) |
| `moveUser` | `{ userId, toOrganizationId, newUsername?: string }` | `{ userId, organizationId, username }` | NOT_FOUND, CONFLICT (username taken in target; client asks for `newUsername`) |
| `previewMoveTeam` | `{ teamId, toOrganizationId }` | `{ membersOutsideTarget: { userId, name, email }[], slugTaken: boolean }` | NOT_FOUND |
| `moveTeam` | `{ teamId, toOrganizationId, newSlug?: string, outsideMembers: "move" \| "remove" }` | `{ teamId, organizationId, slug }` | NOT_FOUND, CONFLICT |

`OrganizationDto` has: `{ id, name, slug, domain, isDefault, memberCount, teamCount, owners: { userId, name, email }[] }`. `OrganizationListItemDto` is the same without `owners`.

The existing admin `users.list` and teams lists gain an `organization: { id, name }` column and an `organizationId` filter (US2-5).

## `viewer.organization.*`: members of the caller's organization

The organization is always the caller's own organization. No `organizationId` is accepted from the client.

| Procedure | Who | Input | Output | Errors |
|-----------|-----|-------|--------|--------|
| `current` | any member | — | `OrganizationDto` minus counts; plus `viewerRole` | |
| `listMembers` | any member | `{ search?, cursor?, limit? }` | `{ items: { userId, name, email, username, role, accepted }[], nextCursor? }` (pending invitees have `accepted: false`) | |
| `inviteMember` | ADMIN, OWNER | `{ email, role: "MEMBER" \| "ADMIN" \| "OWNER" }` | `{ invited: true }` | FORBIDDEN (granting OWNER as ADMIN), CONFLICT (email belongs to another org: "belongs to another organization") |
| `updateRole` | ADMIN, OWNER | `{ userId, role }` | `{ userId, role }` | FORBIDDEN, PRECONDITION_FAILED (last owner) |
| `removeMember` | ADMIN, OWNER | `{ userId }` | `{ userId }` | FORBIDDEN, PRECONDITION_FAILED (last owner); the effect is a move to the default org (FR-011) |
| `listTeams` | any member (read-only); ADMIN and OWNER see every team | `{ search?, cursor?, limit? }` | `{ items: { teamId, name, slug, memberCount, viewerIsMember }[], nextCursor? }` (a MEMBER sees only their own teams) | |

Team management for org admins (delete a team, add or remove members of a team they are not in) reuses the existing `viewer.teams.*` procedures. Their permission check is extended: "team admin **or** org ADMIN/OWNER of the team's parent org".

## Changed behaviour of existing procedures

| Procedure | Change |
|-----------|--------|
| `viewer.teams.create` | `parentId = caller's org`; slug unique within the org |
| `viewer.teams.isSlugAvailable` | checks within the caller's org |
| `viewer.teams.inviteMember` | invitee lookup within the team's org; members of other orgs are refused (CONFLICT "belongs to another organization"); new users are created in the team's org |
| `viewer.teams.get` / `listMembers` / … with an id from another org | NOT_FOUND (already true through membership checks; covered by tests) |
| `viewer.me.updateProfile` | username uniqueness checked within the caller's org |
| `/api/username` | org taken from the request host, not from the body |
| signup (`/api/auth/signup`) | the invitation-less sign-up joins the host's organization (on the default domain that is the default org, FR-013); a token sign-up joins the token team's org |
