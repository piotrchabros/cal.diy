import type { NotetakerSummaryStatusDto } from "@calcom/lib/dto/NotetakerSummaryDto";

export type NotetakerSummaryRecord = {
  id: string;
  transcriptId: string;
  status: NotetakerSummaryStatusDto;
  language: string | null;
  overview: string | null;
  keyPoints: string[];
  decisions: string[];
  actionItems: { text: string; owner: string | null }[];
  model: string | null;
  attempts: number;
  failureCode: string | null;
  generatedAt: Date | null;
};

export interface INotetakerSummaryRepository {
  findByTranscriptId(transcriptId: string): Promise<NotetakerSummaryRecord | null>;
  upsertPending(transcriptId: string): Promise<NotetakerSummaryRecord>;
  incrementAttempts(transcriptId: string): Promise<number>;
  saveResult(
    transcriptId: string,
    data: Pick<
      NotetakerSummaryRecord,
      "status" | "language" | "overview" | "keyPoints" | "decisions" | "actionItems" | "model" | "generatedAt"
    >
  ): Promise<NotetakerSummaryRecord>;
  setStatus(
    transcriptId: string,
    status: NotetakerSummaryStatusDto,
    failureCode: string | null
  ): Promise<void>;
}
