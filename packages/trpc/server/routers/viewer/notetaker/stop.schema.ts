import { z } from "zod";

export const ZStopInputSchema = z.object({ bookingUid: z.string() });
export type TStopInputSchema = z.infer<typeof ZStopInputSchema>;
