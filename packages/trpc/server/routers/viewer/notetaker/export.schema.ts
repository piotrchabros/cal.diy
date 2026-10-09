import { z } from "zod";

export const ZExportInputSchema = z.object({ bookingUid: z.string(), format: z.literal("markdown") });
export type TExportInputSchema = z.infer<typeof ZExportInputSchema>;
