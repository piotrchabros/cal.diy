import { z } from "zod";

const MAX_RANGE_MS = 8 * 24 * 60 * 60 * 1000;

export const ZExternalCalendarEventsInputSchema = z
  .object({
    from: z.date(),
    to: z.date(),
  })
  .refine(({ from, to }) => to.getTime() > from.getTime() && to.getTime() - from.getTime() <= MAX_RANGE_MS, {
    message: "to must be after from and the range must not exceed 8 days",
  });

export type TExternalCalendarEventsInputSchema = z.infer<typeof ZExternalCalendarEventsInputSchema>;
