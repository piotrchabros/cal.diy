import { z } from "zod";

export const ZGetEventTypeDefaultInputSchema = z.object({ eventTypeId: z.number().int() });
export type TGetEventTypeDefaultInputSchema = z.infer<typeof ZGetEventTypeDefaultInputSchema>;
