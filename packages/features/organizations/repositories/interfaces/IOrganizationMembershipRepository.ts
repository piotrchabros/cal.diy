import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";

export type MembershipUserRecord = {
  id: number;
  username: string | null;
  email: string;
  organizationId: number | null;
};

export type AddMemberInput = {
  organizationId: number;
  userId: number;
  username: string;
  role: OrganizationRoleDto;
};

export type OrganizationMemberRecord = {
  membershipId: number;
  userId: number;
  name: string | null;
  email: string;
  username: string | null;
  role: OrganizationRoleDto;
  accepted: boolean;
};

export type OrganizationTeamRecord = {
  teamId: number;
  name: string;
  slug: string | null;
  memberCount: number;
  viewerIsMember: boolean;
};

export interface IOrganizationMembershipRepository {
  findUserById(userId: number): Promise<MembershipUserRecord | null>;
  findUserByEmail(email: string): Promise<MembershipUserRecord | null>;
  isUsernameTaken(p: { organizationId: number; username: string; excludeUserId: number }): Promise<boolean>;
  addMember(
    input: AddMemberInput
  ): Promise<{ userId: number; organizationId: number; role: OrganizationRoleDto }>;
  findRole(p: { organizationId: number; userId: number }): Promise<OrganizationRoleDto | null>;
  findMembership(p: {
    organizationId: number;
    userId: number;
  }): Promise<{ role: OrganizationRoleDto; accepted: boolean } | null>;
  countOwners(organizationId: number): Promise<number>;
  updateRole(p: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<{ userId: number; role: OrganizationRoleDto }>;
  listMembers(p: {
    organizationId: number;
    search?: string;
    cursor?: number;
    limit: number;
  }): Promise<{ items: OrganizationMemberRecord[]; nextCursor?: number }>;
  listTeams(p: {
    organizationId: number;
    viewerUserId: number;
    memberUserId?: number;
    search?: string;
    cursor?: number;
    limit: number;
  }): Promise<{ items: OrganizationTeamRecord[]; nextCursor?: number }>;
  createPendingMembership(p: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<void>;
  updateUsername(params: { userId: number; organizationId: number | null; username: string }): Promise<void>;
  updateUsernameAndUpsertProfile(params: {
    userId: number;
    organizationId: number;
    username: string;
  }): Promise<void>;
}
