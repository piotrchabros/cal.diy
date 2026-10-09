import { z } from "zod";

export const ZRegenerateSummaryInputSchema = z.object({ bookingUid: z.string() });
export type TRegenerateSummaryInputSchema = z.infer<typeof ZRegenerateSummaryInputSchema>;
