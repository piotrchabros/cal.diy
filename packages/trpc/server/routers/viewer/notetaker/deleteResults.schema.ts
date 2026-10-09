import { z } from "zod";

export const ZDeleteResultsInputSchema = z.object({ bookingUid: z.string() });
export type TDeleteResultsInputSchema = z.infer<typeof ZDeleteResultsInputSchema>;
