import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import type {
  AddMemberInput,
  IOrganizationMembershipRepository,
  MembershipUserRecord,
  OrganizationMemberRecord,
  OrganizationTeamRecord,
} from "../repositories/interfaces/IOrganizationMembershipRepository";

type StoredUser = MembershipUserRecord & { name: string | null };

type StoredProfile = { userId: number; organizationId: number; username: string };

type StoredTeam = {
  id: number;
  name: string;
  slug: string | null;
  parentId: number | null;
  isOrganization: boolean;
};

type StoredMembership = { userId: number; teamId: number; role: OrganizationRoleDto; accepted: boolean };

export class InMemoryOrganizationMembershipRepository implements IOrganizationMembershipRepository {
  users: StoredUser[] = [];
  profiles: StoredProfile[] = [];
  memberships: StoredMembership[] = [];
  teams: StoredTeam[] = [];
  updateRoleCalls = 0;
  private membershipIds = new Map<StoredMembership, number>();
  private nextMembershipId = 1;

  seedUser(params: {
    id: number;
    username?: string | null;
    name?: string | null;
    email?: string;
    organizationId?: number | null;
  }): StoredUser {
    const user: StoredUser = {
      id: params.id,
      name: params.name ?? null,
      username: params.username === undefined ? `user${params.id}` : params.username,
      email: params.email ?? `user${params.id}@example.com`,
      organizationId: params.organizationId ?? null,
    };
    this.users = this.users.filter((existing) => existing.id !== params.id);
    this.users.push(user);
    return { ...user };
  }

  seedMembership(params: {
    userId: number;
    teamId: number;
    role: OrganizationRoleDto;
    accepted?: boolean;
  }): StoredMembership {
    const membership: StoredMembership = { ...params, accepted: params.accepted ?? true };
    this.memberships = this.memberships.filter(
      (existing) => !(existing.userId === params.userId && existing.teamId === params.teamId)
    );
    this.pushMembership(membership);
    return { ...membership };
  }

  seedTeam(params: {
    id: number;
    parentId: number | null;
    name?: string;
    slug?: string | null;
    isOrganization?: boolean;
  }): StoredTeam {
    const team: StoredTeam = {
      id: params.id,
      parentId: params.parentId,
      name: params.name ?? `Team ${params.id}`,
      slug: params.slug === undefined ? `team-${params.id}` : params.slug,
      isOrganization: params.isOrganization ?? false,
    };
    this.teams = this.teams.filter((existing) => existing.id !== params.id);
    this.teams.push(team);
    return { ...team };
  }

  seedProfile(params: StoredProfile): StoredProfile {
    this.profiles = this.profiles.filter(
      (existing) => !(existing.userId === params.userId && existing.organizationId === params.organizationId)
    );
    this.profiles.push({ ...params });
    return { ...params };
  }

  async findUserById(userId: number): Promise<MembershipUserRecord | null> {
    const user = this.users.find((existing) => existing.id === userId);
    return user ? this.toUserRecord(user) : null;
  }

  async findUserByEmail(email: string): Promise<MembershipUserRecord | null> {
    const normalizedEmail = email.toLowerCase();
    const user = this.users.find((existing) => existing.email.toLowerCase() === normalizedEmail);
    return user ? this.toUserRecord(user) : null;
  }

  async isUsernameTaken(params: {
    organizationId: number;
    username: string;
    excludeUserId: number;
  }): Promise<boolean> {
    return this.profiles.some(
      (profile) =>
        profile.organizationId === params.organizationId &&
        profile.username === params.username &&
        profile.userId !== params.excludeUserId
    );
  }

  async addMember(
    input: AddMemberInput
  ): Promise<{ userId: number; organizationId: number; role: OrganizationRoleDto }> {
    const user = this.users.find((existing) => existing.id === input.userId);
    if (!user) throw new Error(`InMemoryOrganizationMembershipRepository: user ${input.userId} not seeded`);
    user.organizationId = input.organizationId;
    user.username = input.username;

    const profile = this.findProfile(input.organizationId, input.userId);
    if (profile) {
      profile.username = input.username;
    } else {
      this.profiles.push({
        userId: input.userId,
        organizationId: input.organizationId,
        username: input.username,
      });
    }

    let membership = this.findStoredMembership(input.organizationId, input.userId);
    if (membership) {
      membership.accepted = true;
    } else {
      membership = {
        userId: input.userId,
        teamId: input.organizationId,
        role: input.role,
        accepted: true,
      };
      this.pushMembership(membership);
    }

    return { userId: input.userId, organizationId: input.organizationId, role: membership.role };
  }

  async findRole(params: { organizationId: number; userId: number }): Promise<OrganizationRoleDto | null> {
    const membership = this.findStoredMembership(params.organizationId, params.userId);
    return membership?.accepted ? membership.role : null;
  }

  async findMembership(params: {
    organizationId: number;
    userId: number;
  }): Promise<{ role: OrganizationRoleDto; accepted: boolean } | null> {
    const membership = this.findStoredMembership(params.organizationId, params.userId);
    return membership ? { role: membership.role, accepted: membership.accepted } : null;
  }

  async countOwners(organizationId: number): Promise<number> {
    return this.memberships.filter(
      (membership) =>
        membership.teamId === organizationId && membership.role === "OWNER" && membership.accepted
    ).length;
  }

  async listMembers(params: {
    organizationId: number;
    search?: string;
    cursor?: number;
    limit: number;
  }): Promise<{ items: OrganizationMemberRecord[]; nextCursor?: number }> {
    const search = params.search?.toLowerCase();
    const records: OrganizationMemberRecord[] = [];
    for (const membership of this.memberships) {
      if (membership.teamId !== params.organizationId) continue;
      const membershipId = this.membershipIds.get(membership) ?? 0;
      if (params.cursor !== undefined && membershipId <= params.cursor) continue;
      const user = this.users.find((existing) => existing.id === membership.userId);
      if (!user) continue;
      if (search && ![user.name, user.email, user.username].some((v) => v?.toLowerCase().includes(search))) {
        continue;
      }
      records.push({
        membershipId,
        userId: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        role: membership.role,
        accepted: membership.accepted,
      });
    }
    records.sort((a, b) => a.membershipId - b.membershipId);

    const items = records.slice(0, params.limit);
    const nextCursor = records.length > params.limit ? items[items.length - 1].membershipId : undefined;
    return { items, nextCursor };
  }

  async listTeams(params: {
    organizationId: number;
    viewerUserId: number;
    memberUserId?: number;
    search?: string;
    cursor?: number;
    limit: number;
  }): Promise<{ items: OrganizationTeamRecord[]; nextCursor?: number }> {
    const search = params.search?.toLowerCase();
    const isAcceptedMember = (teamId: number, userId: number) =>
      this.findStoredMembership(teamId, userId)?.accepted === true;
    const records = this.teams
      .filter(
        (team) =>
          team.parentId === params.organizationId &&
          !team.isOrganization &&
          (params.cursor === undefined || team.id > params.cursor) &&
          (params.memberUserId === undefined || isAcceptedMember(team.id, params.memberUserId)) &&
          (!search || [team.name, team.slug].some((v) => v?.toLowerCase().includes(search)))
      )
      .sort((a, b) => a.id - b.id)
      .map((team) => ({
        teamId: team.id,
        name: team.name,
        slug: team.slug,
        memberCount: this.memberships.filter((m) => m.teamId === team.id && m.accepted).length,
        viewerIsMember: isAcceptedMember(team.id, params.viewerUserId),
      }));

    const items = records.slice(0, params.limit);
    const nextCursor = records.length > params.limit ? items[items.length - 1].teamId : undefined;
    return { items, nextCursor };
  }

  async updateRole(params: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<{ userId: number; role: OrganizationRoleDto }> {
    this.updateRoleCalls += 1;
    const membership = this.findStoredMembership(params.organizationId, params.userId);
    if (!membership) {
      throw new Error(
        `InMemoryOrganizationMembershipRepository: membership ${params.userId}/${params.organizationId} not found`
      );
    }
    membership.role = params.role;
    return { userId: params.userId, role: membership.role };
  }

  async createPendingMembership(params: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<void> {
    this.pushMembership({
      userId: params.userId,
      teamId: params.organizationId,
      role: params.role,
      accepted: false,
    });
  }

  private pushMembership(membership: StoredMembership): void {
    this.membershipIds.set(membership, this.nextMembershipId++);
    this.memberships.push(membership);
  }

  private toUserRecord(user: StoredUser): MembershipUserRecord {
    const { name: _name, ...record } = user;
    return record;
  }

  private findProfile(organizationId: number, userId: number): StoredProfile | undefined {
    return this.profiles.find(
      (profile) => profile.organizationId === organizationId && profile.userId === userId
    );
  }

  private findStoredMembership(organizationId: number, userId: number): StoredMembership | undefined {
    return this.memberships.find(
      (membership) => membership.teamId === organizationId && membership.userId === userId
    );
  }
}
