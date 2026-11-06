import type {
  OrganizationDto,
  OrganizationListItemDto,
  OrganizationOwnerDto,
} from "@calcom/lib/dto/OrganizationDto";

export type OrganizationRecord = Omit<OrganizationDto, "isDefault">;

export type OrganizationListItemRecord = Omit<OrganizationListItemDto, "isDefault">;

export type OrganizationListParams = { search?: string; cursor?: number; limit: number };

export type OrganizationListPage = { items: OrganizationListItemRecord[]; nextCursor?: number };

export type OrganizationCreateInput = { name: string; slug: string; domain: string };

export type OrganizationUpdateInput = { name?: string; slug?: string; domain?: string };

export type TeamParentRecord = { id: number; parentId: number | null; isOrganization: boolean };

export interface IOrganizationRepository {
  findById(id: number): Promise<OrganizationRecord | null>;
  findBySlug(slug: string): Promise<OrganizationRecord | null>;
  findByDomain(domain: string): Promise<OrganizationRecord | null>;
  findDefault(defaultDomain: string): Promise<OrganizationRecord | null>;
  list(params: OrganizationListParams): Promise<OrganizationListPage>;
  create(input: OrganizationCreateInput): Promise<OrganizationRecord>;
  update(id: number, input: OrganizationUpdateInput): Promise<OrganizationRecord | null>;
  delete(id: number): Promise<{ id: number } | null>;
  countMembers(organizationId: number): Promise<number>;
  countTeams(organizationId: number): Promise<number>;
  findOwners(organizationId: number): Promise<OrganizationOwnerDto[]>;
  findDomainById(id: number): Promise<string | null>;
  findTeamParentById(teamId: number): Promise<TeamParentRecord | null>;
}
