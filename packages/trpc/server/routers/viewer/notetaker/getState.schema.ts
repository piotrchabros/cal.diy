import { z } from "zod";

export const ZGetStateInputSchema = z.object({ bookingUid: z.string() });

export type TGetStateInputSchema = z.infer<typeof ZGetStateInputSchema>;
