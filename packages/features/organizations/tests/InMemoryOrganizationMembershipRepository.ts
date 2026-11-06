import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import type {
  AddMemberInput,
  IOrganizationMembershipRepository,
  MembershipUserRecord,
} from "../repositories/interfaces/IOrganizationMembershipRepository";

type StoredUser = MembershipUserRecord;

type StoredProfile = { userId: number; organizationId: number; username: string };

type StoredMembership = { userId: number; teamId: number; role: OrganizationRoleDto; accepted: boolean };

export class InMemoryOrganizationMembershipRepository implements IOrganizationMembershipRepository {
  users: StoredUser[] = [];
  profiles: StoredProfile[] = [];
  memberships: StoredMembership[] = [];
  updateRoleCalls = 0;

  seedUser(params: {
    id: number;
    username?: string | null;
    email?: string;
    organizationId?: number | null;
  }): StoredUser {
    const user: StoredUser = {
      id: params.id,
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
    this.memberships.push(membership);
    return { ...membership };
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
    return user ? { ...user } : null;
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

    let membership = this.findMembership(input.organizationId, input.userId);
    if (membership) {
      membership.accepted = true;
    } else {
      membership = {
        userId: input.userId,
        teamId: input.organizationId,
        role: input.role,
        accepted: true,
      };
      this.memberships.push(membership);
    }

    return { userId: input.userId, organizationId: input.organizationId, role: membership.role };
  }

  async findRole(params: { organizationId: number; userId: number }): Promise<OrganizationRoleDto | null> {
    return this.findMembership(params.organizationId, params.userId)?.role ?? null;
  }

  async countOwners(organizationId: number): Promise<number> {
    return this.memberships.filter(
      (membership) => membership.teamId === organizationId && membership.role === "OWNER"
    ).length;
  }

  async updateRole(params: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<{ userId: number; role: OrganizationRoleDto }> {
    this.updateRoleCalls += 1;
    const membership = this.findMembership(params.organizationId, params.userId);
    if (!membership) {
      throw new Error(
        `InMemoryOrganizationMembershipRepository: membership ${params.userId}/${params.organizationId} not found`
      );
    }
    membership.role = params.role;
    return { userId: params.userId, role: membership.role };
  }

  private findProfile(organizationId: number, userId: number): StoredProfile | undefined {
    return this.profiles.find(
      (profile) => profile.organizationId === organizationId && profile.userId === userId
    );
  }

  private findMembership(organizationId: number, userId: number): StoredMembership | undefined {
    return this.memberships.find(
      (membership) => membership.teamId === organizationId && membership.userId === userId
    );
  }
}
