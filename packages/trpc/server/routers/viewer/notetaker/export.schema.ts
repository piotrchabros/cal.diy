import { z } from "zod";

export const ZExportInputSchema = z.object({ bookingUid: z.string(), format: z.enum(["markdown", "html"]) });
export type TExportInputSchema = z.infer<typeof ZExportInputSchema>;
