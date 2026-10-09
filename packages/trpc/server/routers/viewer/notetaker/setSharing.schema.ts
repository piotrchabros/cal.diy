import { z } from "zod";

export const ZSetSharingInputSchema = z.object({ bookingUid: z.string(), shared: z.boolean() });
export type TSetSharingInputSchema = z.infer<typeof ZSetSharingInputSchema>;
