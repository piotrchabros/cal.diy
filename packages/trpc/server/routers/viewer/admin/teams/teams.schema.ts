import { z } from "zod";

export const ZListTeamsPaginatedInputSchema = z.object({
  limit: z.number().int().min(1).max(100),
  cursor: z.number().int().positive().nullish(),
  searchTerm: z.string().trim().max(100).nullish(),
  organizationId: z.number().int().positive().nullish(),
});

export type TListTeamsPaginatedInput = z.infer<typeof ZListTeamsPaginatedInputSchema>;
