import type { Prisma, User } from "@calcom/prisma/client";
import { TestingModule } from "@nestjs/testing";
import { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import { PrismaWriteService } from "@/modules/prisma/prisma-write.service";

type OrganizationLookupClient = Pick<PrismaWriteService["prisma"], "team">;

// Mirrors normalizeHost from @calcom/lib/organizations/normalizeHost, which API v2 cannot import
function defaultOrganizationDomain(): string {
  const hostname = new URL(process.env.NEXT_PUBLIC_WEBAPP_URL ?? "http://localhost:3000").hostname;
  return hostname.toLowerCase().replace(/\.+$/, "") || "localhost";
}

async function findDefaultOrganizationId(
  prisma: OrganizationLookupClient,
  domain: string
): Promise<number | null> {
  const organization = await prisma.team.findFirst({
    where: { isOrganization: true, organizationSettings: { customDomain: domain } },
    select: { id: true },
  });
  return organization?.id ?? null;
}

// Every user needs an organization (users.organizationId is NOT NULL), so fixtures default to the
// instance's default organization, the same one the app assigns to new users.
export async function getOrCreateDefaultOrganizationId(prisma: OrganizationLookupClient): Promise<number> {
  const domain = defaultOrganizationDomain();
  const existingId = await findDefaultOrganizationId(prisma, domain);
  if (existingId !== null) return existingId;

  try {
    const created = await prisma.team.create({
      data: {
        name: "Default",
        slug: "default",
        isOrganization: true,
        organizationSettings: {
          create: {
            customDomain: domain,
            isOrganizationConfigured: true,
            isOrganizationVerified: true,
            orgAutoAcceptEmail: "",
          },
        },
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    // Parallel test files race to create it; the loser reads the winner's row.
    const isUniqueConstraintError =
      typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
    if (!isUniqueConstraintError) throw error;
    const raceWinnerId = await findDefaultOrganizationId(prisma, domain);
    if (raceWinnerId === null) throw error;
    return raceWinnerId;
  }
}

type UserFixtureCreateInput = Omit<Prisma.UserCreateInput, "organization"> &
  Partial<Pick<Prisma.UserCreateInput, "organization">>;

export class UserRepositoryFixture {
  private prismaReadClient: PrismaReadService["prisma"];
  private prismaWriteClient: PrismaWriteService["prisma"];

  constructor(module: TestingModule) {
    this.prismaReadClient = module.get(PrismaReadService).prisma;
    this.prismaWriteClient = module.get(PrismaWriteService).prisma;
  }

  async get(userId: User["id"]) {
    return this.prismaReadClient.user.findFirst({ where: { id: userId } });
  }

  async create(data: UserFixtureCreateInput) {
    try {
      // avoid uniq constraint in tests
      await this.deleteByEmail(data.email);
    } catch {}

    const organization = data.organization ?? {
      connect: { id: await getOrCreateDefaultOrganizationId(this.prismaWriteClient) },
    };
    return this.prismaWriteClient.user.create({ data: { ...data, organization } });
  }

  async createOAuthManagedUser(email: Prisma.UserCreateInput["email"], oAuthClientId: string) {
    try {
      // avoid uniq constraint in tests
      await this.deleteByEmail(email);
    } catch {}

    const defaultOrganizationId = await getOrCreateDefaultOrganizationId(this.prismaWriteClient);
    return this.prismaWriteClient.user.create({
      data: {
        email,
        organization: { connect: { id: defaultOrganizationId } },
        platformOAuthClients: {
          connect: { id: oAuthClientId },
        },
      },
    });
  }

  async delete(userId: User["id"]) {
    return this.prismaWriteClient.user.delete({ where: { id: userId } });
  }

  async deleteByEmail(email: User["email"]) {
    return this.prismaWriteClient.user.delete({ where: { email } });
  }

  async createSecondaryEmail(userId: User["id"], email: string, emailVerified: Date | null) {
    return this.prismaWriteClient.secondaryEmail.create({
      data: {
        userId,
        email,
        emailVerified,
      },
    });
  }
}
