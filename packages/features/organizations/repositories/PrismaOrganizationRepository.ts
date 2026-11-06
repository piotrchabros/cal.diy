import type { OrganizationOwnerDto } from "@calcom/lib/dto/OrganizationDto";
import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";
import type {
  IOrganizationRepository,
  OrganizationCreateInput,
  OrganizationListItemRecord,
  OrganizationListPage,
  OrganizationListParams,
  OrganizationRecord,
  OrganizationUpdateInput,
  TeamParentRecord,
} from "./interfaces/IOrganizationRepository";

const organizationWhere = { isOrganization: true, parentId: null } satisfies Prisma.TeamWhereInput;

const ownerSelect = {
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.MembershipSelect;

const organizationListItemSelect = {
  id: true,
  name: true,
  slug: true,
  organizationSettings: { select: { customDomain: true } },
  _count: { select: { orgUsers: true, children: true } },
} satisfies Prisma.TeamSelect;

const organizationSelect = {
  ...organizationListItemSelect,
  members: {
    where: { role: MembershipRole.OWNER, accepted: true },
    orderBy: { id: "asc" },
    select: ownerSelect,
  },
} satisfies Prisma.TeamSelect;

type OrganizationListItemRow = Prisma.TeamGetPayload<{ select: typeof organizationListItemSelect }>;
type OrganizationRow = Prisma.TeamGetPayload<{ select: typeof organizationSelect }>;
type OwnerRow = Prisma.MembershipGetPayload<{ select: typeof ownerSelect }>;

function toOwner({ user }: OwnerRow): OrganizationOwnerDto {
  return { userId: user.id, name: user.name, email: user.email };
}

function toListItemRecord(row: OrganizationListItemRow): OrganizationListItemRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    domain: row.organizationSettings?.customDomain ?? null,
    memberCount: row._count.orgUsers,
    teamCount: row._count.children,
  };
}

function toRecord(row: OrganizationRow): OrganizationRecord {
  return { ...toListItemRecord(row), owners: row.members.map(toOwner) };
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

export class PrismaOrganizationRepository implements IOrganizationRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findById(id: number): Promise<OrganizationRecord | null> {
    const row = await this.prismaClient.team.findFirst({
      where: { id, ...organizationWhere },
      select: organizationSelect,
    });
    return row ? toRecord(row) : null;
  }

  async findBySlug(slug: string): Promise<OrganizationRecord | null> {
    const row = await this.prismaClient.team.findFirst({
      where: { slug, ...organizationWhere },
      orderBy: { id: "asc" },
      select: organizationSelect,
    });
    return row ? toRecord(row) : null;
  }

  async findByDomain(domain: string): Promise<OrganizationRecord | null> {
    const row = await this.prismaClient.team.findFirst({
      where: { ...organizationWhere, organizationSettings: { customDomain: domain } },
      select: organizationSelect,
    });
    return row ? toRecord(row) : null;
  }

  async findDefault(defaultDomain: string): Promise<OrganizationRecord | null> {
    return this.findByDomain(defaultDomain);
  }

  async list({ search, cursor, limit }: OrganizationListParams): Promise<OrganizationListPage> {
    const rows = await this.prismaClient.team.findMany({
      where: {
        ...organizationWhere,
        ...(cursor !== undefined && { id: { gt: cursor } }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { slug: { contains: search, mode: "insensitive" } },
            { organizationSettings: { customDomain: { contains: search, mode: "insensitive" } } },
          ],
        }),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
      select: organizationListItemSelect,
    });

    const items = rows.slice(0, limit).map(toListItemRecord);
    if (rows.length <= limit) return { items };
    return { items, nextCursor: items[limit - 1].id };
  }

  async create({ name, slug, domain }: OrganizationCreateInput): Promise<OrganizationRecord> {
    const row = await this.prismaClient.team.create({
      data: {
        name,
        slug,
        isOrganization: true,
        organizationSettings: {
          create: {
            customDomain: domain,
            isOrganizationConfigured: true,
            isOrganizationVerified: true,
            // Upstream auto-join paths match signup emails against orgAutoAcceptEmail, so leaving it
            // empty keeps strangers from silently joining an organization.
            orgAutoAcceptEmail: "",
          },
        },
      },
      select: organizationSelect,
    });
    return toRecord(row);
  }

  async update(
    id: number,
    { name, slug, domain }: OrganizationUpdateInput
  ): Promise<OrganizationRecord | null> {
    try {
      const row = await this.prismaClient.team.update({
        where: { id, ...organizationWhere },
        data: {
          name,
          slug,
          ...(domain !== undefined && {
            organizationSettings: {
              upsert: {
                create: {
                  customDomain: domain,
                  orgAutoAcceptEmail: "",
                  isOrganizationConfigured: true,
                  isOrganizationVerified: true,
                },
                update: { customDomain: domain },
              },
            },
          }),
        },
        select: organizationSelect,
      });
      return toRecord(row);
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  async delete(id: number): Promise<{ id: number } | null> {
    try {
      // Deleting the team cascades to its settings, memberships, profiles and child teams,
      // so callers must check the member and team counts before calling this.
      return await this.prismaClient.team.delete({
        where: { id, ...organizationWhere },
        select: { id: true },
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  async countMembers(organizationId: number): Promise<number> {
    return this.prismaClient.user.count({ where: { organizationId } });
  }

  async countTeams(organizationId: number): Promise<number> {
    return this.prismaClient.team.count({ where: { parentId: organizationId } });
  }

  async findOwners(organizationId: number): Promise<OrganizationOwnerDto[]> {
    const rows = await this.prismaClient.membership.findMany({
      where: { teamId: organizationId, role: MembershipRole.OWNER, accepted: true },
      orderBy: { id: "asc" },
      select: ownerSelect,
    });
    return rows.map(toOwner);
  }

  async findDomainById(id: number): Promise<string | null> {
    const row = await this.prismaClient.team.findFirst({
      where: { id, ...organizationWhere },
      select: { organizationSettings: { select: { customDomain: true } } },
    });
    return row?.organizationSettings?.customDomain ?? null;
  }

  async findTeamParentById(teamId: number): Promise<TeamParentRecord | null> {
    return this.prismaClient.team.findUnique({
      where: { id: teamId },
      select: { id: true, parentId: true, isOrganization: true },
    });
  }
}
