import { MembershipRole } from "@calcom/prisma/enums";
import { z } from "zod";

export const ZTeamInviteMemberSchema = z.object({
  teamId: z.number().int().positive(),
  email: z.string().email().max(254),
  role: z.nativeEnum(MembershipRole).default(MembershipRole.MEMBER),
});

export type TTeamInviteMemberSchema = z.infer<typeof ZTeamInviteMemberSchema>;
