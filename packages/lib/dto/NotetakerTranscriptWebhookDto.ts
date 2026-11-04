import type { NotetakerTranscriptCompletenessDto } from "./NotetakerTranscriptDto";

export type NotetakerTranscriptWebhookPassage = {
  index: number;
  speakerKey: string;
  speakerName: string | null;
  unknownSpeakerNumber: number | null;
  startMs: number;
  endMs: number;
  text: string;
};

export type NotetakerTranscriptWebhookSummary = {
  status: "READY" | "FAILED";
  language: string | null;
  overview: string | null;
  keyPoints: unknown[];
  decisions: unknown[];
  actionItems: unknown[];
  topics: unknown[];
};

export type NotetakerTranscriptWebhookPayload = {
  version: 1;
  sessionId: string;
  transcriptId: string;
  language: string | null;
  completeness: NotetakerTranscriptCompletenessDto;
  durationMs: number;
  speakerNamesAvailable: boolean | null;
  passages: NotetakerTranscriptWebhookPassage[];
  summary: NotetakerTranscriptWebhookSummary | null;
};

export type NotetakerBookingSource = "booking" | "ad_hoc" | "calendar_auto_join";
