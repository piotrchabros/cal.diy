import type { EventTypeHostServiceDeps } from "@calcom/features/host/services/EventTypeHostService";
import type { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import type { OrganizationMembershipService } from "@calcom/features/organizations/services/OrganizationMembershipService";
import type { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import type { TeamProfileService } from "@calcom/features/teams/services/TeamProfileService";
import type { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { MembershipRole } from "@calcom/prisma/enums";
import { InMemoryNotetakerMembershipLookup } from "../../notetaker/tests/InMemoryNotetakerMembershipLookup";
import { createInMemoryNotetakerRepositories } from "../../notetaker/tests/InMemoryNotetakerRepositories";

type InviteToken = { id: number; teamId: number; email: string; token: string; expires: Date };

type TeamProfilePrisma = ConstructorParameters<typeof TeamProfileService>[0];

type MemberFilter = { teamId: number; search?: string | null; roles?: MembershipRole[]; accepted?: boolean };

const matches = (user: WorldUser, search?: string | null) => {
  const needle = search?.trim().toLowerCase();
  return !needle || user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
};

export type WorldUser = {
  id: number;
  email: string;
  name: string;
  username: string | null;
  organizationId: number | null;
};
export type WorldTeam = {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  isOrganization: boolean;
};
export type WorldMembership = {
  id: number;
  userId: number;
  teamId: number;
  role: MembershipRole;
  accepted: boolean;
};
export type WorldHost = { eventTypeId: number; userId: number; isFixed: boolean };
export type WorldEventType = { id: number; teamId: number };

// One store behind every adapter, so a write made through one service (an invite) is what
// the next lookup sees, and a refusal can only come from the services' own checks.
export class InMemoryIsolationWorld {
  users: WorldUser[] = [];
  teams: WorldTeam[] = [];
  memberships: WorldMembership[] = [];
  hosts: WorldHost[] = [];
  eventTypes: WorldEventType[] = [];
  inviteTokens: InviteToken[] = [];
  private nextId = 1000;

  addUser(user: WorldUser) {
    this.users.push({ ...user });
  }

  addTeam(team: WorldTeam) {
    this.teams.push({ ...team });
  }

  addMembership(membership: Omit<WorldMembership, "id">) {
    const created = { id: this.nextId++, ...membership };
    this.memberships.push(created);
    return created;
  }

  user(id: number) {
    return this.users.find((user) => user.id === id) ?? null;
  }

  membership(userId: number, teamId: number) {
    return this.memberships.find((m) => m.userId === userId && m.teamId === teamId) ?? null;
  }

  private teamMembers({ teamId, search, roles, accepted }: MemberFilter) {
    return this.memberships
      .filter((m) => m.teamId === teamId)
      .filter((m) => accepted === undefined || m.accepted === accepted)
      .filter((m) => !roles?.length || roles.includes(m.role))
      .map((m) => ({ membership: m, user: this.user(m.userId) }))
      .filter((row): row is { membership: WorldMembership; user: WorldUser } => !!row.user)
      .filter((row) => matches(row.user, search))
      .sort((a, b) => a.user.id - b.user.id);
  }

  membershipRepository() {
    const adapter = {
      findUniqueByUserIdAndTeamId: async ({ userId, teamId }: { userId: number; teamId: number }) =>
        this.membership(userId, teamId),
      hasMembership: async ({ userId, teamId }: { userId: number; teamId: number }) =>
        !!this.membership(userId, teamId)?.accepted,
      findTeamMembers: async (args: MemberFilter & { skip: number; take: number }) =>
        this.teamMembers(args)
          .slice(args.skip, args.skip + args.take)
          .map(({ membership, user }) => ({
            id: membership.id,
            role: membership.role,
            accepted: membership.accepted,
            createdAt: new Date(0),
            user: { ...user, avatarUrl: null, lastActiveAt: null },
          })),
      countTeamMembers: async (args: MemberFilter) => this.teamMembers(args).length,
      createTeamMembership: async (data: Omit<WorldMembership, "id">) => {
        const { id, role, accepted } = this.addMembership(data);
        return { id, role, accepted };
      },
      searchMembers: async (
        args: MemberFilter & { cursor?: number | null; limit: number; memberUserIds?: number[] | null }
      ) => {
        const rows = this.teamMembers({ ...args, accepted: true })
          .filter((row) => !args.cursor || row.user.id > args.cursor)
          .filter((row) => !args.memberUserIds || args.memberUserIds.includes(row.user.id));
        const hasMore = rows.length > args.limit;
        const page = rows.slice(0, args.limit);
        return {
          memberships: page.map(({ membership, user }) => ({
            role: membership.role,
            user: { ...user, avatarUrl: null, defaultScheduleId: null },
          })),
          nextCursor: hasMore ? page[page.length - 1].user.id : undefined,
          hasMore,
        };
      },
    };
    return adapter as unknown as MembershipRepository;
  }

  teamRepository() {
    const adapter = {
      findBasicById: async ({ teamId }: { teamId: number }) => {
        const team = this.teams.find((t) => t.id === teamId);
        return team ? { ...team, logoUrl: null } : null;
      },
      findTeamInviteTokenByEmail: async ({ teamId, email }: { teamId: number; email: string }) =>
        this.inviteTokens.find((t) => t.teamId === teamId && t.email === email.toLowerCase()) ?? null,
      createTeamInviteToken: async (data: Omit<InviteToken, "id">) => {
        const token = { id: this.nextId++, ...data, email: data.email.toLowerCase() };
        this.inviteTokens.push(token);
        return token;
      },
      deleteTeamInviteTokens: async ({ teamId, email }: { teamId: number; email: string }) => {
        this.inviteTokens = this.inviteTokens.filter(
          (t) => !(t.teamId === teamId && t.email === email.toLowerCase())
        );
      },
    };
    return adapter as unknown as TeamRepository;
  }

  userRepository() {
    const adapter = {
      findInviteeByEmail: async ({ email }: { email: string }) => {
        const user = this.users.find((u) => u.email === email.toLowerCase());
        return user ? { ...user, locale: "en", identityProvider: "CAL", hasPassword: true } : null;
      },
      setOrganizationId: async ({ id, organizationId }: { id: number; organizationId: number }) => {
        const user = this.user(id);
        if (user) user.organizationId = organizationId;
      },
      findOrganizationIdsByIds: async ({ ids }: { ids: number[] }) =>
        this.users
          .filter((u) => ids.includes(u.id))
          .map(({ id, organizationId }) => ({ id, organizationId })),
    };
    return adapter as unknown as UserRepository;
  }

  hostRepository() {
    const adapter = {
      findHostsPaginatedIncludeUserForAssignment: async ({ eventTypeId }: { eventTypeId: number }) => {
        const items = this.hosts
          .filter((host) => host.eventTypeId === eventTypeId)
          .map((host) => ({ host, user: this.user(host.userId) }))
          .filter((row): row is { host: WorldHost; user: WorldUser } => !!row.user)
          .map(({ host, user }) => ({
            userId: host.userId,
            isFixed: host.isFixed,
            priority: null,
            weight: null,
            scheduleId: null,
            groupId: null,
            user: { name: user.name, email: user.email, avatarUrl: null },
          }));
        return { items, nextCursor: undefined, hasMore: false, hasFixedHosts: items.some((i) => i.isFixed) };
      },
    };
    return adapter as unknown as EventTypeHostServiceDeps["hostRepository"];
  }

  eventTypeHostDeps(): EventTypeHostServiceDeps {
    const eventTypeRepository = {
      getTeamIdByEventTypeId: async ({ id }: { id: number }) => {
        const eventType = this.eventTypes.find((e) => e.id === id);
        return eventType ? { teamId: eventType.teamId } : null;
      },
    };
    return {
      hostRepository: this.hostRepository(),
      membershipRepository: this.membershipRepository(),
      eventTypeRepository,
      teamRepository: this.teamRepository(),
      userRepository: this.userRepository(),
    };
  }

  organizationMembershipService(): Pick<OrganizationMembershipService, "addMember"> {
    return {
      addMember: async ({ organizationId, userId, role }) => {
        const user = this.user(userId);
        if (user) user.organizationId = organizationId;
        this.addMembership({ userId, teamId: organizationId, role, accepted: true });
        return { userId, organizationId, role };
      },
    };
  }

  teamProfilePrisma(): TeamProfilePrisma {
    const adapter = {
      membership: {
        findUnique: async ({ where }: { where: { userId_teamId: { userId: number; teamId: number } } }) =>
          this.membership(where.userId_teamId.userId, where.userId_teamId.teamId),
      },
      team: {
        findUnique: async ({ where }: { where: { id: number } }) => {
          const team = this.teams.find((t) => t.id === where.id);
          return team ? { ...team, logoUrl: null, bio: null, metadata: {} } : null;
        },
      },
    };
    return adapter as unknown as TeamProfilePrisma;
  }

  // The notetaker fakes keep their own state, so they are filled from this store rather
  // than seeded separately; the organization of each event type follows its team's parent.
  notetakerFakes() {
    const repositories = createInMemoryNotetakerRepositories();
    const membershipLookup = new InMemoryNotetakerMembershipLookup();
    for (const user of this.users) {
      repositories.store.setUser(user.id, { name: user.name, email: user.email, avatarUrl: null });
    }
    for (const m of this.memberships) {
      const user = this.user(m.userId);
      membershipLookup.addMember({ ...m, name: user?.name ?? null, email: user?.email });
    }
    for (const eventType of this.eventTypes) {
      const team = this.teams.find((t) => t.id === eventType.teamId);
      repositories.store.addEventType({
        id: eventType.id,
        userId: null,
        teamId: eventType.teamId,
        locations: null,
        ownerName: null,
        teamName: team?.name ?? null,
        organizationId: team?.parentId ?? null,
      });
    }
    return { repositories, membershipLookup };
  }
}

export const ORG_A = 100;
export const TEAM_A = 110;
export const ORG_B = 200;
export const TEAM_B = 210;
export const EVENT_TYPE_A = 1100;
export const EVENT_TYPE_B = 2100;
export const ALICE = 1;
export const ADAM = 2;
export const BOB = 3;
export const BEA = 4;

export function seedTwoOrgs(): InMemoryIsolationWorld {
  const world = new InMemoryIsolationWorld();
  const orgs = [
    { orgId: ORG_A, teamId: TEAM_A, eventTypeId: EVENT_TYPE_A, name: "Acme", owner: ALICE, member: ADAM },
    { orgId: ORG_B, teamId: TEAM_B, eventTypeId: EVENT_TYPE_B, name: "Bolt", owner: BOB, member: BEA },
  ];
  const names: Record<number, string> = { [ALICE]: "Alice", [ADAM]: "Adam", [BOB]: "Bob", [BEA]: "Bea" };
  for (const org of orgs) {
    const slug = org.name.toLowerCase();
    world.addTeam({ id: org.orgId, name: org.name, slug, parentId: null, isOrganization: true });
    world.addTeam({
      id: org.teamId,
      name: `${org.name} Sales`,
      slug: "sales",
      parentId: org.orgId,
      isOrganization: false,
    });
    for (const [userId, role] of [
      [org.owner, MembershipRole.OWNER],
      [org.member, MembershipRole.MEMBER],
    ] as const) {
      const name = names[userId];
      world.addUser({
        id: userId,
        email: `${name.toLowerCase()}@${slug}.test`,
        name,
        username: name.toLowerCase(),
        organizationId: org.orgId,
      });
      world.addMembership({ userId, teamId: org.orgId, role, accepted: true });
      world.addMembership({ userId, teamId: org.teamId, role, accepted: true });
    }
    world.eventTypes.push({ id: org.eventTypeId, teamId: org.teamId });
    world.hosts.push({ eventTypeId: org.eventTypeId, userId: org.owner, isFixed: true });
  }
  return world;
}
