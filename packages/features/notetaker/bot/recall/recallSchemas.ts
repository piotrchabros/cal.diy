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

export const recallTranscriptProviderSchema = z.record(z.string(), z.unknown());

export const recallTranscriptShortcutSchema = z.object({
  id: z.string(),
  status: recallCodeSchema.nullish(),
  data: z.object({ download_url: z.string().nullish() }).nullish(),
  provider: recallTranscriptProviderSchema.nullish(),
});
export type RecallTranscriptShortcut = z.infer<typeof recallTranscriptShortcutSchema>;

export const recallVideoMixedShortcutSchema = z.object({
  id: z.string(),
  status: recallCodeSchema.nullish(),
  data: z.object({ download_url: z.string().nullish() }).nullish(),
  format: z.string().nullish(),
});
export type RecallVideoMixedShortcut = z.infer<typeof recallVideoMixedShortcutSchema>;

export const recallRecordingSchema = z.object({
  id: z.string(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  status: recallCodeSchema.nullish(),
  expires_at: z.string().nullish(),
  media_shortcuts: z
    .object({
      transcript: recallTranscriptShortcutSchema.nullish(),
      video_mixed: recallVideoMixedShortcutSchema.nullish(),
    })
    .nullish(),
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
  provider: recallTranscriptProviderSchema.nullish(),
});
export type RecallTranscriptArtifact = z.infer<typeof recallTranscriptArtifactSchema>;

export const recallTranscriptListSchema = z.object({
  results: z.array(recallTranscriptArtifactSchema).default([]),
  next: z.string().nullish(),
});
export type RecallTranscriptList = z.infer<typeof recallTranscriptListSchema>;

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

// One envelope covers both realtime events: transcript.data carries `words`, chat_message carries the inner `data`.
export const recallRealtimeEnvelopeSchema = z.object({
  event: z.string(),
  data: z.object({
    data: z
      .object({
        participant: z
          .object({ id: z.number().int(), name: z.string().nullish(), is_host: z.boolean().nullish() })
          .nullish(),
        words: z.array(z.object({ text: z.string() })).nullish(),
        data: z.object({ text: z.string().nullish(), to: z.string().nullish() }).nullish(),
      })
      .nullish(),
    bot: z.object({ id: z.string(), metadata: z.record(z.string(), z.unknown()).nullish() }),
  }),
});
export type RecallRealtimeEnvelope = z.infer<typeof recallRealtimeEnvelopeSchema>;

export type RecallRealtimeEventName = "participant_events.chat_message" | "transcript.data";

export type RecallStreamingTranscriptProvider =
  | { deepgram_streaming: { model: "nova-3"; language: "multi"; mip_opt_out: true } }
  | { recallai_streaming: { mode: "prioritize_low_latency"; language_code: "en" } };

export type RecallRecordingConfig = {
  transcript?: { provider: RecallStreamingTranscriptProvider };
  realtime_endpoints: Array<{ type: "webhook"; url: string; events: RecallRealtimeEventName[] }>;
};

export type RecallCreateBotRequest = {
  meeting_url: string;
  bot_name: string;
  join_at?: string;
  automatic_video_output?: {
    in_call_recording: { kind: "jpeg"; b64_data: string };
    in_call_not_recording: { kind: "jpeg"; b64_data: string };
  };
  metadata: Record<string, string>;
  chat: { on_bot_join: { send_to: "everyone"; message: string; pin: boolean } };
  automatic_leave: {
    waiting_room_timeout: number;
    noone_joined_timeout: number;
    everyone_left_timeout: { timeout: number };
    in_call_recording_timeout: number;
  };
  recording_config?: RecallRecordingConfig;
};

export type RecallCreateTranscriptRequest = {
  provider: { recallai_async: { language_code: "auto" } };
  diarization: { use_separate_streams_when_available: true };
};

export type RecallSendChatMessageRequest = { to: "everyone"; message: string };
