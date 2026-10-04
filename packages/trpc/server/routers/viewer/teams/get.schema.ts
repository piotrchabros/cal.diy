import { z } from "zod";

export const ZTeamGetSchema = z.object({
  teamId: z.number().int().positive(),
});

export type TTeamGetSchema = z.infer<typeof ZTeamGetSchema>;
