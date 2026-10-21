import { z } from "zod";

const recallCodeSchema = z.object({ code: z.string() });

export const RECALL_SESSION_METADATA_KEY = "notetakerSessionId";

// Recall adds fields and sub-codes between API versions, so every schema is lenient and strips unknown keys.

export const recallStatusChangeSchema = z.object({
  code: z.string(),
  sub_code: z.string().nullish(),
  created_at: z.string(),
});
export type RecallStatusChange = z.infer<typeof recallStatusChangeSchema>;

export const recallTranscriptShortcutSchema = z.object({
  id: z.string(),
  status: recallCodeSchema.nullish(),
  data: z.object({ download_url: z.string().nullish() }).nullish(),
});
export type RecallTranscriptShortcut = z.infer<typeof recallTranscriptShortcutSchema>;

export const recallRecordingSchema = z.object({
  id: z.string(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  status: recallCodeSchema.nullish(),
  media_shortcuts: z.object({ transcript: recallTranscriptShortcutSchema.nullish() }).nullish(),
});
export type RecallRecording = z.infer<typeof recallRecordingSchema>;

export const recallBotSchema = z.object({
  id: z.string(),
  status_changes: z.array(recallStatusChangeSchema).default([]),
  recordings: z.array(recallRecordingSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type RecallBot = z.infer<typeof recallBotSchema>;

export const recallBotListSchema = z.object({
  results: z.array(recallBotSchema).default([]),
  next: z.string().nullish(),
});
export type RecallBotList = z.infer<typeof recallBotListSchema>;

export const recallTranscriptArtifactSchema = z.object({
  id: z.string(),
  status: recallCodeSchema.nullish(),
  data: z.object({ download_url: z.string().nullish() }).nullish(),
});
export type RecallTranscriptArtifact = z.infer<typeof recallTranscriptArtifactSchema>;

export const recallTranscriptEntrySchema = z.object({
  participant: z.object({ id: z.number().int(), name: z.string().nullish() }),
  language_code: z.string().nullish(),
  words: z.array(
    z.object({
      text: z.string(),
      start_timestamp: z.object({ relative: z.number() }),
      end_timestamp: z.object({ relative: z.number() }).nullish(),
    })
  ),
});
export type RecallTranscriptEntry = z.infer<typeof recallTranscriptEntrySchema>;

export const recallTranscriptDownloadSchema = z.array(recallTranscriptEntrySchema);
export type RecallTranscriptDownload = z.infer<typeof recallTranscriptDownloadSchema>;

export const recallWebhookEnvelopeSchema = z.object({
  event: z.string(),
  data: z.object({
    data: z
      .object({
        code: z.string().optional(),
        sub_code: z.string().nullish(),
        updated_at: z.string().optional(),
      })
      .optional(),
    bot: z.object({ id: z.string(), metadata: z.record(z.string(), z.unknown()).nullish() }).optional(),
    recording: z.object({ id: z.string() }).optional(),
    transcript: z.object({ id: z.string() }).optional(),
  }),
});
export type RecallWebhookEnvelope = z.infer<typeof recallWebhookEnvelopeSchema>;

export type RecallCreateBotRequest = {
  meeting_url: string;
  bot_name: string;
  join_at: string;
  metadata: Record<string, string>;
  chat: { on_bot_join: { send_to: "everyone"; message: string; pin: boolean } };
  automatic_leave: {
    waiting_room_timeout: number;
    noone_joined_timeout: number;
    everyone_left_timeout: { timeout: number; activate_after: number };
    in_call_recording_timeout: number;
  };
};

export type RecallCreateTranscriptRequest = {
  provider: { recallai_async: { language_code: "auto" } };
  diarization: { use_separate_streams_when_available: true };
};
