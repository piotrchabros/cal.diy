import { z } from "zod";

export const ZGetActivityInputSchema = z.object({ bookingUid: z.string() });
export type TGetActivityInputSchema = z.infer<typeof ZGetActivityInputSchema>;
