import type {
  NotetakerTranscriptWebhookPassage,
  NotetakerTranscriptWebhookPayload,
  NotetakerTranscriptWebhookSummary,
} from "@calcom/lib/dto/NotetakerTranscriptWebhookDto";
import type { NotetakerSummaryRecord } from "../repositories/interfaces/INotetakerSummaryRepository";
import type {
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toWebhookPassage(passage: NotetakerPassageRecord): NotetakerTranscriptWebhookPassage {
  return {
    index: passage.index,
    speakerKey: passage.speakerKey,
    speakerName: passage.speakerName,
    unknownSpeakerNumber: passage.unknownSpeakerNumber,
    startMs: passage.startMs,
    endMs: passage.endMs,
    text: passage.text,
  };
}

function toWebhookSummary(summary: NotetakerSummaryRecord | null): NotetakerTranscriptWebhookSummary | null {
  if (!summary || (summary.status !== "READY" && summary.status !== "FAILED")) return null;
  return {
    status: summary.status,
    language: summary.language,
    overview: summary.overview,
    keyPoints: toArray(summary.keyPoints),
    decisions: toArray(summary.decisions),
    actionItems: toArray(summary.actionItems),
    topics: toArray(summary.topics),
  };
}

export function buildNotetakerTranscriptWebhookPayload(params: {
  transcript: NotetakerTranscriptRecord;
  passages: NotetakerPassageRecord[];
  summary: NotetakerSummaryRecord | null;
}): NotetakerTranscriptWebhookPayload {
  const { transcript, passages, summary } = params;
  return {
    version: 1,
    sessionId: transcript.sessionId,
    transcriptId: transcript.id,
    language: transcript.language,
    completeness: transcript.completeness,
    durationMs: transcript.durationMs,
    speakerNamesAvailable: transcript.speakerNamesAvailable,
    passages: [...passages].sort((a, b) => a.index - b.index).map(toWebhookPassage),
    summary: toWebhookSummary(summary),
  };
}
