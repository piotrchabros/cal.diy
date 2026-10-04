import { z } from "zod";

export const ZTeamAcceptInviteSchema = z.object({
  teamId: z.number().int().positive(),
});

export type TTeamAcceptInviteSchema = z.infer<typeof ZTeamAcceptInviteSchema>;
