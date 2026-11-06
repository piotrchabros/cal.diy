# Data Model: Organizations

**Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

## Schema changes (need the owner's approval)

### Change 1: organization domain (PR 1)

```prisma
model OrganizationSettings {
  // ...existing fields...
  /// Lowercase host name without scheme or port, e.g. "cal.bespokesoft.pl"
  customDomain String? @unique
}
```

Migration: `ALTER TABLE "OrganizationSettings" ADD COLUMN "customDomain" TEXT; CREATE UNIQUE INDEX ... ON "OrganizationSettings"("customDomain");`. It is additive and safe to apply before any code that uses it.

### Change 2: the BlueBee switch-over (PR 22, data only, no DDL)

This is a repeat-safe SQL migration (`... ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS`). It does the following:

1. Inserts `Team` "BlueBee" (`slug = 'bluebee'`, `isOrganization = true`, `parentId = NULL`) if no organization with that slug exists.
2. Inserts its `OrganizationSettings` with `customDomain = 'cal.bluebee.marketing'`, `isOrganizationConfigured = true` and `isOrganizationVerified = true`.
3. Sets `Team.parentId = <BlueBee id>` for every team where `isOrganization = false AND parentId IS NULL`.
4. Sets `User.organizationId = <BlueBee id>` for every user where `organizationId IS NULL`.
5. Inserts a `Profile` (`uid = gen_random_uuid()`, `userId`, `organizationId`, `username = users.username`) for each user without one in BlueBee.
6. Inserts an accepted `Membership` on BlueBee for each user without one. The role is OWNER for `users.role = 'ADMIN'` and MEMBER for everyone else.

Before and after counts are printed with `RAISE NOTICE` for the owner to compare (SC-003).

### Change 3: enforce one organization per user (PR 23, after the switch-over is verified)

```prisma
model User {
  organizationId Int   // was Int?
  organization   Team  @relation("scope", fields: [organizationId], references: [id], onDelete: Restrict)
}
```

The migration fails loudly if any `organizationId IS NULL` remains. `onDelete: Restrict` backs FR-004: an organization with members cannot be deleted.

## Entities

### Organization

An organization is a `Team` row with `isOrganization = true` and `parentId = NULL`. Its `OrganizationSettings` row is 1:1.

| Field | Source | Rules |
|-------|--------|-------|
| id | `Team.id` | |
| name | `Team.name` | 1 to 100 characters |
| slug | `Team.slug` | `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`, at least 2 characters, unique among organizations (enforced in the service: `parentId IS NULL` rows are not covered by the unique index) |
| domain | `OrganizationSettings.customDomain` | valid FQDN, lowercase, no port or scheme; unique |
| isDefault | derived | `domain == host(NEXT_PUBLIC_WEBAPP_URL)` |

Lifecycle: an instance admin creates it (US1), edits it, and can delete it only when it has no members and no teams. The default organization can never be deleted.

### Organization membership

| Row | Fields |
|-----|--------|
| `User.organizationId` | the org id (the user's one organization) |
| `Profile` | `userId`, `organizationId`, `username` (unique per org), `uid` |
| `Membership` | `userId`, `teamId = org id`, `role` ∈ {OWNER, ADMIN, MEMBER}, `accepted = true` |

These three rows are always written together by `OrganizationMembershipService` in one transaction.

Invariants:
- Every user has exactly one membership row on an organization team.
- An organization always has at least one OWNER.
- `users.username` equals `Profile.username` for the user's org. Both are written on change.

Role rules (US4):
- ADMIN can grant MEMBER and ADMIN.
- Only an OWNER can grant or remove OWNER.
- The last OWNER cannot be demoted or removed.

### Team (top-level)

`Team` with `isOrganization = false` and `parentId = <org id>`. Its slug is unique per org through the existing `@@unique([slug, parentId])`. Its members must have `User.organizationId = parentId` (enforced in `TeamMembersService`).

### Link redirect

An existing `TempOrgRedirect` row:

| Field | Value on a move |
|-------|-----------------|
| from | old username or old team slug |
| fromOrgId | old org id |
| type | `User` or `Team` (event-type pages fall under the user or team prefix) |
| toUrl | `https://<new domain>/<new username>` or `https://<new domain>/team/<new slug>` |
| enabled | `true`; set to `false` when the old org reuses `from` |

### Organization audit entry

These are structured log lines (`logger.info` with `action`, `actorUserId`, `organizationId`, `targetUserId` / `targetTeamId`), with ids only and no new table (FR-023). A table can come later if querying is needed. That would be a separate spec.

## State transitions

```text
User:  [BlueBee member] --instance admin move--> [Org B member]   (leaves all BlueBee teams; redirect created)
       [Org member] --org admin removes--> [BlueBee member]        (FR-011)
Team:  [in Org A] --instance admin move (members resolved)--> [in Org B]   (redirect created)
Org:   created --> active --(no members, no teams, not default)--> deleted
```
