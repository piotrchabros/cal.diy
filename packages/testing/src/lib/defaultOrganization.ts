import { WEBAPP_URL } from "@calcom/lib/constants";
import { normalizeHost } from "@calcom/lib/organizations/normalizeHost";
import type { PrismaClient } from "@calcom/prisma";

type OrganizationLookupClient = Pick<PrismaClient, "team">;

function defaultOrganizationDomain(): string {
  return normalizeHost(new URL(WEBAPP_URL).host) ?? "localhost";
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
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

// Every user needs an organization (users.organizationId is NOT NULL), so tests that create users
// directly use the instance's default organization, the same one the app assigns to new users.
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
    if (!isUniqueConstraintError(error)) throw error;
    const raceWinnerId = await findDefaultOrganizationId(prisma, domain);
    if (raceWinnerId === null) throw error;
    return raceWinnerId;
  }
}
