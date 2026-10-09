import { z } from "zod";

export const notetakerFinalizeSessionSchema = z.object({ sessionId: z.string() });
export const notetakerGenerateSummarySchema = z.object({
  transcriptId: z.string(),
  requestedByUserId: z.number().nullable(),
});
export const notetakerNotificationKindSchema = z.enum([
  "ATTENDEE_NOTICE",
  "ADMIT_PROMPT",
  "RESULTS_READY",
  "FAILED",
  "TURNED_OFF",
  "SHARED_WITH_ATTENDEES",
]);
export const notetakerSendNotificationSchema = z.object({
  kind: notetakerNotificationKindSchema,
  bookingId: z.number(),
  sessionId: z.string().nullable(),
});
