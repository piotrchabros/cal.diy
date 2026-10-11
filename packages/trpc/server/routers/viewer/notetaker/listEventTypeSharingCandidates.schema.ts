import { z } from "zod";

export const ZListEventTypeSharingCandidatesInputSchema = z.object({
  eventTypeId: z.number().int(),
  teamId: z.number().int().positive().optional(),
  search: z.string().trim().max(100).optional(),
  cursor: z.number().int().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type TListEventTypeSharingCandidatesInputSchema = z.infer<
  typeof ZListEventTypeSharingCandidatesInputSchema
>;
