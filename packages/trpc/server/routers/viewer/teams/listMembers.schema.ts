import { MembershipRole } from "@calcom/prisma/enums";
import { z } from "zod";

export const ZTeamListMembersSchema = z.object({
  teamId: z.number().int().positive(),
  search: z.string().max(200).optional(),
  roles: z.nativeEnum(MembershipRole).array().optional(),
  accepted: z.boolean().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(10),
});

export type TTeamListMembersSchema = z.infer<typeof ZTeamListMembersSchema>;
