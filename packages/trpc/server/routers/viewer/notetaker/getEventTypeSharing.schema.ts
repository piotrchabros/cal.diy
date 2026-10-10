import { z } from "zod";

export const ZGetEventTypeSharingInputSchema = z.object({ eventTypeId: z.number().int() });
export type TGetEventTypeSharingInputSchema = z.infer<typeof ZGetEventTypeSharingInputSchema>;
