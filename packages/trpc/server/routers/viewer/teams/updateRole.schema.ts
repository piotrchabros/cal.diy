import { MembershipRole } from "@calcom/prisma/enums";
import { z } from "zod";

export const ZTeamUpdateRoleSchema = z.object({
  teamId: z.number().int().positive(),
  userId: z.number().int().positive(),
  role: z.nativeEnum(MembershipRole),
});

export type TTeamUpdateRoleSchema = z.infer<typeof ZTeamUpdateRoleSchema>;
