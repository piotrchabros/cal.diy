import { z } from "zod";

export const ZDispatchToMeetingInputSchema = z.object({
  meetingUrl: z.string().trim().min(1).max(2048),
  title: z.string().trim().min(1).max(200).optional(),
  durationMinutes: z.number().int().min(15).max(240).optional(),
  sharingTeamId: z.number().int().positive().nullable(),
  acknowledgedNotice: z.literal(true),
});

export type TDispatchToMeetingInputSchema = z.infer<typeof ZDispatchToMeetingInputSchema>;
