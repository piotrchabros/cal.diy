import { z } from "zod";

export const ZTeamRemoveMemberSchema = z.object({
  teamId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

export type TTeamRemoveMemberSchema = z.infer<typeof ZTeamRemoveMemberSchema>;
