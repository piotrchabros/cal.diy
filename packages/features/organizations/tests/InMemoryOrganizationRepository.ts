import type { OrganizationOwnerDto } from "@calcom/lib/dto/OrganizationDto";
import type {
  IOrganizationRepository,
  OrganizationCreateInput,
  OrganizationListPage,
  OrganizationListParams,
  OrganizationRecord,
  OrganizationUpdateInput,
  TeamParentRecord,
} from "../repositories/interfaces/IOrganizationRepository";

type StoredOrganization = {
  id: number;
  name: string;
  slug: string | null;
  domain: string | null;
  logoUrl: string | null;
  owners: OrganizationOwnerDto[];
  memberCount: number;
  teamCount: number;
  autoAcceptEmailDomain: string | null;
};

export class InMemoryOrganizationRepository implements IOrganizationRepository {
  private organizations: StoredOrganization[] = [];
  private teams: TeamParentRecord[] = [];
  private nextId = 1;

  seed(params: {
    id?: number;
    name: string;
    slug?: string | null;
    domain?: string | null;
    logoUrl?: string | null;
    owners?: OrganizationOwnerDto[];
    memberCount?: number;
    teamCount?: number;
    autoAcceptEmailDomain?: string | null;
  }): OrganizationRecord {
    const id = params.id ?? this.nextId;
    this.nextId = Math.max(this.nextId, id + 1);
    const stored: StoredOrganization = {
      id,
      name: params.name,
      slug: params.slug ?? null,
      domain: params.domain ?? null,
      logoUrl: params.logoUrl ?? null,
      owners: params.owners ?? [],
      memberCount: params.memberCount ?? 0,
      teamCount: params.teamCount ?? 0,
      autoAcceptEmailDomain: params.autoAcceptEmailDomain ?? null,
    };
    this.organizations = this.organizations.filter((organization) => organization.id !== id);
    this.organizations.push(stored);
    return this.toRecord(stored);
  }

  seedTeam(params: { id: number; parentId?: number | null; isOrganization?: boolean }): TeamParentRecord {
    const team: TeamParentRecord = {
      id: params.id,
      parentId: params.parentId ?? null,
      isOrganization: params.isOrganization ?? false,
    };
    this.teams = this.teams.filter((existing) => existing.id !== params.id);
    this.teams.push(team);
    return { ...team };
  }

  setMemberCount(organizationId: number, memberCount: number): void {
    this.getStored(organizationId).memberCount = memberCount;
  }

  setTeamCount(organizationId: number, teamCount: number): void {
    this.getStored(organizationId).teamCount = teamCount;
  }

  setOwners(organizationId: number, owners: OrganizationOwnerDto[]): void {
    this.getStored(organizationId).owners = owners;
  }

  all(): OrganizationRecord[] {
    return this.sorted().map((organization) => this.toRecord(organization));
  }

  async findById(id: number): Promise<OrganizationRecord | null> {
    return this.findWhere((organization) => organization.id === id);
  }

  async findBySlug(slug: string): Promise<OrganizationRecord | null> {
    return this.findWhere((organization) => organization.slug === slug);
  }

  async findByDomain(domain: string): Promise<OrganizationRecord | null> {
    return this.findWhere((organization) => organization.domain === domain);
  }

  async findDefault(defaultDomain: string): Promise<OrganizationRecord | null> {
    return this.findWhere((organization) => organization.domain === defaultDomain);
  }

  async list(params: OrganizationListParams): Promise<OrganizationListPage> {
    const search = params.search?.trim().toLowerCase();
    const matching = this.sorted().filter((organization) => {
      if (params.cursor !== undefined && organization.id <= params.cursor) return false;
      if (!search) return true;
      return [organization.name, organization.slug, organization.domain].some((value) =>
        value?.toLowerCase().includes(search)
      );
    });
    const pageItems = matching.slice(0, params.limit);
    const hasMore = matching.length > params.limit;
    return {
      items: pageItems.map(
        ({ owners: _owners, logoUrl: _logoUrl, autoAcceptEmailDomain: _domain, ...item }) => ({ ...item })
      ),
      nextCursor: hasMore ? pageItems[pageItems.length - 1]?.id : undefined,
    };
  }

  async create(input: OrganizationCreateInput): Promise<OrganizationRecord> {
    return this.seed({ name: input.name, slug: input.slug, domain: input.domain });
  }

  async update(id: number, input: OrganizationUpdateInput): Promise<OrganizationRecord | null> {
    const stored = this.organizations.find((organization) => organization.id === id);
    if (!stored) return null;
    if (input.name !== undefined) stored.name = input.name;
    if (input.slug !== undefined) stored.slug = input.slug;
    if (input.domain !== undefined) stored.domain = input.domain;
    if (input.logoUrl !== undefined) stored.logoUrl = input.logoUrl;
    return this.toRecord(stored);
  }

  async delete(id: number): Promise<{ id: number } | null> {
    const exists = this.organizations.some((organization) => organization.id === id);
    if (!exists) return null;
    this.organizations = this.organizations.filter((organization) => organization.id !== id);
    return { id };
  }

  async countMembers(organizationId: number): Promise<number> {
    return this.organizations.find((organization) => organization.id === organizationId)?.memberCount ?? 0;
  }

  async countTeams(organizationId: number): Promise<number> {
    return this.organizations.find((organization) => organization.id === organizationId)?.teamCount ?? 0;
  }

  async findOwners(organizationId: number): Promise<OrganizationOwnerDto[]> {
    const owners = this.organizations.find((organization) => organization.id === organizationId)?.owners;
    return owners ? owners.map((owner) => ({ ...owner })) : [];
  }

  async findDomainById(id: number): Promise<string | null> {
    return this.organizations.find((organization) => organization.id === id)?.domain ?? null;
  }

  async findTeamParentById(teamId: number): Promise<TeamParentRecord | null> {
    const team = this.teams.find((existing) => existing.id === teamId);
    return team ? { ...team } : null;
  }

  async findIdByVerifiedAutoAcceptEmailDomain(domain: string): Promise<number | null> {
    return (
      this.organizations.find((organization) => organization.autoAcceptEmailDomain === domain)?.id ?? null
    );
  }

  private findWhere(predicate: (organization: StoredOrganization) => boolean): OrganizationRecord | null {
    const stored = this.organizations.find(predicate);
    return stored ? this.toRecord(stored) : null;
  }

  private getStored(organizationId: number): StoredOrganization {
    const stored = this.organizations.find((organization) => organization.id === organizationId);
    if (!stored) throw new Error(`InMemoryOrganizationRepository: organization ${organizationId} not seeded`);
    return stored;
  }

  private sorted(): StoredOrganization[] {
    return [...this.organizations].sort((a, b) => a.id - b.id);
  }

  private toRecord({ autoAcceptEmailDomain: _domain, ...stored }: StoredOrganization): OrganizationRecord {
    return { ...stored, owners: stored.owners.map((owner) => ({ ...owner })) };
  }
}
