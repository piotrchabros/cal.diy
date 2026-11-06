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

export interface IOrganizationMembershipRepository {
  findUserById(userId: number): Promise<MembershipUserRecord | null>;
  findUserByEmail(email: string): Promise<MembershipUserRecord | null>;
  isUsernameTaken(p: { organizationId: number; username: string; excludeUserId: number }): Promise<boolean>;
  addMember(
    input: AddMemberInput
  ): Promise<{ userId: number; organizationId: number; role: OrganizationRoleDto }>;
  findRole(p: { organizationId: number; userId: number }): Promise<OrganizationRoleDto | null>;
  countOwners(organizationId: number): Promise<number>;
  updateRole(p: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<{ userId: number; role: OrganizationRoleDto }>;
}
