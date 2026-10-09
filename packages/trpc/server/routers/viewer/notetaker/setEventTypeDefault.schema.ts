import { z } from "zod";

export const ZSetEventTypeDefaultInputSchema = z.object({
  eventTypeId: z.number().int(),
  enabledByDefault: z.boolean(),
});
export type TSetEventTypeDefaultInputSchema = z.infer<typeof ZSetEventTypeDefaultInputSchema>;
