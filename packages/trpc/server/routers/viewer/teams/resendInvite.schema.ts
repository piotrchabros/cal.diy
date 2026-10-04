import { z } from "zod";

export const ZTeamResendInviteSchema = z.object({
  teamId: z.number().int().positive(),
  email: z.string().email().max(254),
});

export type TTeamResendInviteSchema = z.infer<typeof ZTeamResendInviteSchema>;
