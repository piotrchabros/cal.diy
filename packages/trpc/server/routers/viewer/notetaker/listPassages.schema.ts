import { z } from "zod";

export const ZListPassagesInputSchema = z.object({
  bookingUid: z.string(),
  sessionId: z.string().optional(),
  cursor: z.number().int().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type TListPassagesInputSchema = z.infer<typeof ZListPassagesInputSchema>;
