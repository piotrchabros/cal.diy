import type { PrismaClient } from "@calcom/prisma";
import type {
  ITempOrgRedirectRepository,
  RedirectTypeDto,
  TempOrgRedirectRecord,
} from "./interfaces/ITempOrgRedirectRepository";

export class PrismaTempOrgRedirectRepository implements ITempOrgRedirectRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findEnabledByFromSlugs({
    fromOrgId,
    type,
    fromSlugs,
  }: {
    fromOrgId: number;
    type: RedirectTypeDto;
    fromSlugs: string[];
  }): Promise<TempOrgRedirectRecord[]> {
    if (fromSlugs.length === 0) return [];

    return this.prismaClient.tempOrgRedirect.findMany({
      where: { fromOrgId, type, from: { in: Array.from(new Set(fromSlugs)) }, enabled: true },
      select: { from: true, toUrl: true },
    });
  }
}
