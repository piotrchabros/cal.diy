# Feature Specification: Organizations

**Feature Branch**: `005-organizations` (one branch per PR, split in plan.md)

**Created**: 2026-11-06

**Status**: Draft

**Input**: User description: "I want to add an organization feature, so it is possible for admins to create new organizations. An organization is everything bounded to its context, like teams and users." Product-owner decisions (2026-11-06): (1) an instance admin creates an organization and assigns its owner; the organization's owners and admins then manage their own organization's members and teams, and instance admins can still manage every organization; (2) strict isolation, and every user belongs to exactly one organization; existing users and teams move into a default organization; (3) each organization has its own domain that serves the whole app for its members, not just booking pages: BespokeSoft on `cal.bespokesoft.pl`, BlueBee on `cal.bluebee.marketing`, JellyMatch on `cal.jellymatch.tech`; (4) BlueBee is the default organization: it keeps today's domain `cal.bluebee.marketing`, receives every existing user and team, and an instance admin then moves BespokeSoft and JellyMatch people and teams to their organizations; (5) reuse what is left of the upstream organization data model.

**Terms**: *Instance admin*: a user with the instance-wide administrator role (today's `/settings/admin`). *Organization*: a named, slugged container of users and teams, served on its own domain. *Org owner / org admin*: a member of an organization with the owner or admin role in it. *Organization domain*: the host name an organization is served on, e.g. `cal.bespokesoft.pl`. *Default organization*: BlueBee, which owns the instance's current domain and receives every existing user and team, plus new sign-ups that have no invitation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An instance admin creates an organization (Priority: P1)

An instance admin opens the admin area, chooses "Organizations", and creates one by entering a name, a slug, its domain (e.g. `cal.jellymatch.tech`) and an owner. The owner is an existing user, or an email address that receives an invitation. The new organization appears in the list, where the instance admin can also rename it, change its slug or owner, and delete it.

**Why this priority**: Nothing else in the feature exists without organizations; this is the entry point the user asked for.

**Independent Test**: As an instance admin, create "JellyMatch" with slug `jellymatch`, domain `cal.jellymatch.tech` and an invited owner. Check that it is listed, that the owner gets an invitation linking to `cal.jellymatch.tech`, and that a non-admin cannot open the page or call the action.

**Acceptance Scenarios**:

1. **Given** an instance admin on the organizations admin page, **When** they submit a name, a free slug, a free domain and an owner, **Then** the organization is created, the owner becomes its owner, and the list shows it with its domain and its member and team counts.
2. **Given** a slug or a domain that is already used by another organization, or a domain that is not a valid host name, **When** they submit, **Then** creation is refused with a message naming the problem.
3. **Given** an owner email that matches no user, **When** they submit, **Then** the organization is created and an invitation to join it as owner is sent to that address.
4. **Given** an owner who already belongs to another organization, **When** they submit, **Then** the admin is warned that the user will move (see User Story 5) and must confirm.
5. **Given** an organization, **When** the instance admin edits its name, slug, domain or owner, **Then** the change is saved; a domain change warns that links on the old domain stop working and that the new domain must already point at the server.
6. **Given** an organization that still has members or teams, **When** the instance admin tries to delete it, **Then** deletion is refused until they are moved out. The default organization can never be deleted.
7. **Given** a user who is not an instance admin, **When** they open the page or call any of these actions, **Then** access is refused.

---

### User Story 2 - Users and teams stay inside their organization (Priority: P1)

A user only ever sees people and teams of their own organization. Member search, invites, team creation, adding team members, assigning hosts to event types and listing users all draw only from that organization. Every team belongs to exactly one organization, and only that organization's members can join it.

**Why this priority**: This boundary is what the user means by "everything bounded to its context". Without it an organization is just a label.

**Independent Test**: With two organizations, each with users and a team, sign in as a member of the first. Check that no screen, search or action lists, invites or adds anyone or any team from the second, including direct calls with the other organization's ids.

**Acceptance Scenarios**:

1. **Given** members of organizations A and B, **When** a member of A searches for people to add to a team or as a host, **Then** only members of A are returned.
2. **Given** a team admin in A, **When** they invite an email that belongs to a member of B, **Then** the invite is refused with a message that the person belongs to another organization.
3. **Given** a member of A, **When** they create a team, **Then** the team belongs to A.
4. **Given** a team in B, **When** a member of A requests it by id (view, edit, join, list members), **Then** the request is refused as not found.
5. **Given** an instance admin, **When** they use the admin users and teams lists, **Then** they see every organization's users and teams, with an organization column and filter.
6. **Given** two organizations, **When** each has a user `jan` or a team `sales`, **Then** both are allowed; usernames and team slugs only need to be unique inside one organization.

---

### User Story 3 - Each organization is served on its own domain (Priority: P1)

Each organization has its own domain, and that domain serves the whole product for its members: sign-in, settings, bookings, and the public booking pages. `cal.bespokesoft.pl/jan` books Jan of BespokeSoft, `cal.jellymatch.tech/team/sales` books JellyMatch's sales team, and a BespokeSoft member signs in and works on `cal.bespokesoft.pl`. The same username or team slug in another organization resolves only on that organization's domain.

**Why this priority**: The owner wants each company to have its own branded address. Once usernames are unique only per organization, the domain is also what tells two `jan`s apart.

**Independent Test**: Create `jan` in BespokeSoft and in JellyMatch. Open `/jan` on each domain and check that each shows the right person, that the other domain shows "not found", and that each Jan can sign in only on their own domain.

**Acceptance Scenarios**:

1. **Given** user `jan` in BespokeSoft, **When** a visitor opens `cal.bespokesoft.pl/jan`, **Then** Jan's booking page is shown and bookings are made with Jan.
2. **Given** team `sales` in JellyMatch, **When** a visitor opens `cal.jellymatch.tech/team/sales`, **Then** the team page is shown.
3. **Given** a username that exists only in another organization, **When** a visitor opens it on BespokeSoft's domain, **Then** "not found" is shown.
4. **Given** a request for a host name that belongs to no organization, **When** it reaches the app, **Then** it is refused; no organization's content is shown.
5. **Given** links generated anywhere in the product (copy link, emails, embeds, calendar invites, the booking success page, password reset and invitation emails, webhook payloads), **When** they point at a member, a team or the app, **Then** they use the domain of the organization they belong to.
6. **Given** a BespokeSoft member, **When** they sign in on `cal.bespokesoft.pl`, **Then** they are signed in there; **When** they try to sign in on `cal.jellymatch.tech` or `cal.bluebee.marketing`, **Then** they are sent to `cal.bespokesoft.pl` to sign in.
7. **Given** a signed-in session on one organization's domain, **When** the same browser opens another organization's domain, **Then** it is not signed in there. Sessions are per domain.
8. **Given** BlueBee is the default organization on `cal.bluebee.marketing`, **When** a visitor opens an existing link such as `cal.bluebee.marketing/jan` of a BlueBee member, **Then** it keeps working unchanged.
9. **Given** the branding of a page (product name in the title, emails' sender name), **When** it is shown on an organization's domain, **Then** it is unchanged apart from the domain in links. Per-organization branding is out of scope.

---

### User Story 4 - Org owners and admins manage their own organization (Priority: P2)

An org owner or admin opens "Organization" in settings. There they can see their organization's members, invite new people by email, change a member's role (member, admin, owner), remove members, and see and manage all of the organization's teams. They cannot see or touch other organizations.

**Why this priority**: The instance admin should not have to do every membership change by hand. It is not needed for the first usable slice, because the instance admin can do these tasks too.

**Independent Test**: As the owner of BespokeSoft, invite a new address, promote a member to admin, remove a member and delete a team. Check that a plain member of BespokeSoft sees no management actions, and that the owner of BespokeSoft cannot reach anything belonging to JellyMatch.

**Acceptance Scenarios**:

1. **Given** an org admin, **When** they invite an email with no account, **Then** an invitation is sent; on sign-up through it the new user joins that organization.
2. **Given** an org admin, **When** they invite an existing user of the same instance who belongs to another organization, **Then** the invite is refused. Only an instance admin can move users between organizations.
3. **Given** an org admin, **When** they change roles, **Then** admins can grant member and admin, and only owners can grant or remove owner.
4. **Given** the last owner, **When** anyone tries to demote or remove them, **Then** it is refused. An organization always has at least one owner.
5. **Given** an org admin, **When** they remove a member, **Then** the member loses access to the organization's teams. Because every user must belong to one organization, a removed member is moved to the default organization, and their personal event types and bookings stay with them.
6. **Given** an org admin, **When** they open the teams list, **Then** they see every team of the organization, including teams they are not a member of, and can delete them or add and remove members.
7. **Given** a plain member, **When** they open organization settings, **Then** they see the member list read-only and no management actions.

---

### User Story 5 - An instance admin moves users and teams between organizations (Priority: P2)

An instance admin can move a user, or a whole team, from one organization to another. Right after the switch-over everyone is in BlueBee, so the instance admin moves BespokeSoft's people and teams to BespokeSoft and JellyMatch's to JellyMatch.

**Why this priority**: When the feature is switched on everyone lands in BlueBee (User Story 6). Without a way to move people, BespokeSoft and JellyMatch stay empty.

**Independent Test**: Move a user and then a team from BlueBee to BespokeSoft. Check that their pages now live on `cal.bespokesoft.pl`, that their old `cal.bluebee.marketing` links redirect there, that their bookings are kept, and what happened to cross-organization memberships.

**Acceptance Scenarios**:

1. **Given** a user in organization A, **When** the instance admin moves them to B, **Then** they leave every team of A, keep their personal event types, availability, calendars and bookings, their public page moves to B's domain, and they sign in on B's domain from then on.
2. **Given** the user's username is taken in B, **When** the instance admin moves them, **Then** the move asks for a new username before it is applied.
3. **Given** a team in A, **When** the instance admin moves it to B, **Then** members who are not in B are listed first and the instance admin chooses to move them as well or remove them from the team.
4. **Given** the team's slug is taken in B, **When** it is moved, **Then** a new slug is required.
5. **Given** a moved user or team, **When** someone opens their old link on A's domain (the profile, a team page, or an event-type page), **Then** they are permanently redirected to the same page on B's domain, so links already sent in emails, embeds and calendar invites keep working.
6. **Given** a redirect left by a move, **When** someone in A later takes the freed username or team slug, **Then** the redirect is dropped and the new owner's page is shown.
7. **Given** a moved user who was signed in on A's domain, **When** they next use A's domain, **Then** they are sent to B's domain to sign in.

---

### User Story 6 - Existing data moves into BlueBee, the default organization (Priority: P1)

When the feature is switched on, the BlueBee organization is created on today's domain `cal.bluebee.marketing`, and every existing user and every existing team is put into it. Nobody notices anything: same domain, same links, same sign-in.

**Why this priority**: The rule "every user belongs to exactly one organization" is false for the existing data until this happens, and production already has users, teams and public links.

**Independent Test**: On a copy of the production data, run the switch-over. Check that every user and team is in BlueBee, that no user is in two organizations, that counts before and after match, and that a sample of existing public links on `cal.bluebee.marketing` still resolves unchanged.

**Acceptance Scenarios**:

1. **Given** existing users and teams with no organization, **When** the switch-over runs, **Then** BlueBee exists with domain `cal.bluebee.marketing`, every user is a member of it, and every top-level team belongs to it.
2. **Given** the instance admins, **When** the switch-over runs, **Then** they become owners of BlueBee.
3. **Given** the switch-over has already run, **When** it runs again, **Then** nothing changes. It is safe to repeat.
4. **Given** a username or team slug collision, **When** the switch-over runs, **Then** none is possible, because today's usernames and slugs are already unique across the instance.
5. **Given** a production database, **When** the switch-over is prepared, **Then** it is handed to the owner as a reviewed migration to apply before the deploy that depends on it. The deploy itself does not apply migrations.

---

### Edge Cases

- **New sign-ups without an invitation**: they join the default organization, so the "every user belongs to one organization" rule holds.
- **Sign-up through an organization invitation**: the new user joins the inviting organization, and the username must be free in that organization only.
- **An org owner deletes their own account**: refused while they are the last owner.
- **Webhooks, API keys, apps and workflows owned by a team**: they move with the team. Those owned by a user move with the user.
- **Notetaker team sharing (specs 002 to 004)**: sharing targets teams. Because a user can only be in teams of their own organization, a move removes cross-organization sharing access automatically. Meetings shared with a team the user left are no longer visible to them through that team.
- **Embeds and calendar invites created before a move**: they keep the old link, which redirects to the new domain (User Story 5, scenario 5).
- **A domain change on an organization**: links on the old domain stop working; the edit form warns about this (User Story 1, scenario 5).
- **Visiting the app through the server's IP or an unconfigured host**: refused (User Story 3, scenario 4).
- **OAuth callbacks of calendar and video apps (Google, Microsoft, Zoom and so on)**: providers allow only registered redirect addresses. Connecting an app from an organization domain must still complete; see the Assumptions.
- **Instance admin from BespokeSoft**: they use the admin area on `cal.bespokesoft.pl`; it still covers every organization.
- **Booking page of a user who was moved while a visitor had it open**: the booking is refused with "not found" and nothing is created.
- **Instance admins**: they belong to an organization like everyone else, and their instance-wide powers do not depend on which one.

## Requirements *(mandatory)*

### Functional Requirements

**Organizations (instance admin)**

- **FR-001**: Instance admins MUST be able to list, create, edit (name, slug, owner) and delete organizations from the admin area. Every other user MUST be refused, both on the page and on the action.
- **FR-002**: An organization MUST have a slug (lowercase letters, digits and hyphens, 2 to 63 characters) and a domain (a valid fully qualified host name). Both MUST be unique among organizations.
- **FR-003**: An organization MUST have at least one owner at all times.
- **FR-004**: An organization with members or teams MUST NOT be deletable. The default organization MUST NOT be deletable at all.
- **FR-005**: Instance admins MUST be able to move a user or a team between organizations, with the rules in User Story 5.

**Membership and isolation**

- **FR-006**: Every user MUST belong to exactly one organization.
- **FR-007**: Every top-level team MUST belong to exactly one organization, and only members of that organization can be members of the team.
- **FR-008**: Every lookup a non-instance-admin can trigger that returns users or teams MUST be limited to the caller's organization. This covers member search, invites, team creation and membership, event-type host assignment, user lists, availability pickers and "people" filters. A request naming a user or team of another organization MUST be refused as not found.
- **FR-009**: Usernames and team slugs MUST be unique within an organization. They MAY repeat across organizations.
- **FR-010**: Org owners and admins MUST be able to invite people by email, change roles within the limits of User Story 4, remove members, and manage every team of their organization.
- **FR-011**: A member removed from an organization MUST be moved to the default organization, keeping their personal data, unless the removal comes from deleting their account.
- **FR-012**: An invitation from an organization MUST NOT move an existing user who belongs to another organization. Only an instance admin can move users between organizations (FR-005).
- **FR-013**: New users signing up without an organization invitation MUST join the default organization.

**Domains, public pages and links**

- **FR-014**: The whole product (sign-in, settings, bookings, the admin area, public booking pages, APIs used by the product) MUST be served on every organization's domain. On a given domain, usernames and team slugs MUST resolve only within that domain's organization.
- **FR-015**: Every link the product generates MUST use the domain of the organization the subject belongs to: the user's organization for user pages and account emails, the team's organization for team pages, and the organizer's organization for booking emails, calendar invites, embeds, booking confirmations, webhook payloads and API responses.
- **FR-016**: A request for a host name that belongs to no organization MUST be refused without showing any organization's content.
- **FR-017**: Sessions MUST be per domain. A user MUST be able to sign in only on their own organization's domain; a sign-in attempt on another organization's domain MUST send them to their own.
- **FR-018**: Moving a user or team to another organization (FR-005) MUST leave permanent redirects from their pages on the old domain to the same pages on the new domain, until the freed username or slug is reused in the old organization.

**Default organization and switch-over**

- **FR-019**: A one-time, repeat-safe switch-over MUST create the default organization BlueBee (slug `bluebee`, domain `cal.bluebee.marketing`), add every existing user to it, attach every existing top-level team to it, and make instance admins its owners.
- **FR-020**: The switch-over MUST be delivered as a database migration for the owner to review and apply before the deploy that depends on it. It MUST NOT run as part of a deploy.
- **FR-021**: BespokeSoft (`cal.bespokesoft.pl`) and JellyMatch (`cal.jellymatch.tech`) are created afterwards by an instance admin through User Story 1, not by the migration, so their owners and memberships are chosen deliberately.
- **FR-022**: Existing links on `cal.bluebee.marketing` MUST keep working unchanged after the switch-over. After a user or team is moved out of BlueBee, FR-018 applies.

**Audit and safety**

- **FR-023**: Creating, editing, deleting and moving organizations, users and teams across organizations MUST be logged with the acting user, the target ids and the time. Logs carry ids only, no personal data.
- **FR-024**: All new user-facing text MUST be translatable.

### Key Entities *(include if feature involves data)*

- **Organization**: a named container with a unique slug, a unique domain, plus settings. It has members with roles (owner, admin, member) and teams. The existing team-shaped organization record from the upstream data model, flagged as an organization, is reused.
- **Organization membership**: links a user to their one organization, with a role and the user's username inside that organization. The existing per-organization profile is reused.
- **Team**: as today, plus the organization it belongs to (its parent).
- **Default organization**: BlueBee, a normal organization marked as the default. It receives new sign-ups, removed members and all pre-existing data, and cannot be deleted.
- **Link redirect**: left by a move; maps a username or team slug on the old organization's domain to its page on the new domain.
- **Organization audit entry**: who did what to which organization, user or team, and when.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An instance admin can create an organization with an owner in under 1 minute, from opening the admin area.
- **SC-002**: In an automated test with two organizations, 0 of the user- and team-returning actions available to a non-admin return or modify anything from the other organization.
- **SC-003**: After the switch-over, 100% of existing users and top-level teams belong to the default organization, and user and team counts before and after are identical.
- **SC-004**: After the switch-over, 100% of a sample of 50 existing public booking links on `cal.bluebee.marketing` resolve to the same person or team as before, without a redirect; after moving a sample user and team to BespokeSoft, 100% of their old links reach the same page on `cal.bespokesoft.pl` with one redirect.
- **SC-005**: Two users with the same username in two organizations each receive bookings only through their own organization's domain, in 100% of test bookings.
- **SC-006**: In a test of every email type the product sends, 100% of links point at the recipient-relevant organization's domain (FR-015).
- **SC-007**: The feature ships in PRs that each stay under 500 changed lines and 10 code files.

## Assumptions

- **Infrastructure (owner's task, outside the repository)**: DNS records for `cal.bespokesoft.pl` and `cal.jellymatch.tech` pointing at the server, a Caddy site for each domain (Caddy obtains the TLS certificates) proxying to the same app, and each domain added to the app's allowed host names. The product documents these steps; a new organization's domain works only once they are done.
- **One running app serves all domains**: the app today assumes one fixed address in several places (the configured app URL, the sign-in callback URL, allowed host names). Planning must find each and make it follow the request's organization domain. Where a fixed address cannot be avoided, the default organization's domain is used.
- **OAuth app connections**: calendar and video providers only accept registered callback addresses. Because sessions are per domain, the connection callback must run on the user's own domain (research R7), so the owner registers each organization domain's callback with every provider in use ([infra-owner-checklist](./contracts/infra-owner-checklist.md)). Until then, members of that organization cannot connect that app; existing connections keep working.
- **Data model**: the upstream organization structures still in the schema (organization flag on teams, parent team, per-organization profile, organization settings, temporary organization redirects) cover most needs. There is no field for an organization's domain today, so storing it needs a schema change, which goes to the owner for approval during planning, as does any other gap.
- **Feature switch**: the existing organizations environment switch turns on domain routing. Until the switch-over migration is applied and the switch is set, the site behaves as today.
- **Out of scope**: organization billing and seats, self-serve organization sign-up, subdomains, organization-level SSO/SCIM/directory sync, platform/OAuth organizations, managed organizations, organization branding (logo, colours, product name, email sender), and per-organization attributes and routing forms. Upstream code for these stays off.
- **Bookers are unaffected**: people booking a meeting never need an account or an organization.
- **Production safety**: the root `.env` points at the live database. The migration is applied by the owner (`db-deploy`) before deploying; tests that write to the database run only against a scratch database.
- **Delivery order** (refined in plan.md): (1) admin organization CRUD with domains; (2) membership and isolation for users and teams; (3) domain routing, per-domain sign-in and link generation; (4) organization settings for org owners and admins; (5) moving users and teams between organizations, with redirects; (6) the BlueBee switch-over migration, applied by the owner before the deploy that turns on (2) and (3); then the owner creates BespokeSoft and JellyMatch and moves their people.
