import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";

export type MoveUserRecord = {
  id: number;
  username: string | null;
  email: string;
  organizationId: number | null;
};

export type MoveTeamMemberRecord = {
  userId: number;
  name: string | null;
  email: string;
  username: string | null;
  organizationId: number | null;
  accepted: boolean;
};

export type MoveTeamRecord = {
  id: number;
  slug: string | null;
  parentId: number | null;
  isOrganization: boolean;
  members: MoveTeamMemberRecord[];
};

export type MoveRedirectWrite = {
  fromOrgId: number;
  from: string;
  toUrl: string;
};

export type ApplyUserMove = {
  userId: number;
  email: string;
  fromOrganizationId: number | null;
  toOrganizationId: number;
  username: string;
  role: OrganizationRoleDto;
  keepTeamIds: number[];
  redirect: MoveRedirectWrite | null;
};

export type ApplyTeamMove = {
  teamId: number;
  toOrganizationId: number;
  slug: string | null;
  removeMembers: { userId: number; email: string }[];
  redirect: MoveRedirectWrite | null;
};

export type ApplyMoveInput = {
  team?: ApplyTeamMove;
  users: ApplyUserMove[];
};

export interface IOrganizationMoveRepository {
  findUserForMove(userId: number): Promise<MoveUserRecord | null>;
  findTeamForMove(teamId: number): Promise<MoveTeamRecord | null>;
  isTeamSlugTaken(params: { organizationId: number; slug: string; excludeTeamId: number }): Promise<boolean>;
  findTakenUsernames(params: {
    organizationId: number;
    usernames: string[];
    excludeUserIds: number[];
  }): Promise<string[]>;
  applyMove(input: ApplyMoveInput): Promise<void>;
}
