import { z } from "zod";

export const ZListSharedWithMeInputSchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type TListSharedWithMeInputSchema = z.infer<typeof ZListSharedWithMeInputSchema>;
