import { z } from "zod";

export const ZSetCalendarAutoJoinInputSchema = z.object({
  selectedCalendarId: z.string().min(1).max(255),
  enabled: z.boolean(),
  sharingTeamId: z.number().int().positive().nullable(),
});

export type TSetCalendarAutoJoinInputSchema = z.infer<typeof ZSetCalendarAutoJoinInputSchema>;
