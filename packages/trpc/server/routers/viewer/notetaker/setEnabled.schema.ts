import { z } from "zod";

export const ZSetEnabledInputSchema = z.object({
  bookingUid: z.string(),
  enabled: z.boolean(),
  scope: z.enum(["THIS_BOOKING", "ALL_FUTURE_OCCURRENCES"]).default("THIS_BOOKING"),
});
export type TSetEnabledInputSchema = z.infer<typeof ZSetEnabledInputSchema>;
