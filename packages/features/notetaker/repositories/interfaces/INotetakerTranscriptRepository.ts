import type { NotetakerTranscriptCompletenessDto } from "@calcom/lib/dto/NotetakerTranscriptDto";

export type NotetakerTranscriptRecord = {
  id: string;
  sessionId: string;
  bookingId: number;
  language: string | null;
  completeness: NotetakerTranscriptCompletenessDto;
  durationMs: number;
  passageCount: number;
  createdAt: Date;
};

export type NotetakerPassageRecord = {
  index: number;
  speakerKey: string;
  speakerName: string | null;
  unknownSpeakerNumber: number | null;
  startMs: number;
  endMs: number;
  text: string;
  language: string | null;
};

export interface INotetakerTranscriptRepository {
  findBySessionId(sessionId: string): Promise<NotetakerTranscriptRecord | null>;
  findById(id: string): Promise<NotetakerTranscriptRecord | null>;
  findIdsByBookingId(bookingId: number): Promise<{ id: string; sessionId: string }[]>;
  createIfMissing(data: { sessionId: string; bookingId: number }): Promise<NotetakerTranscriptRecord>;
  /** Resolves to the number of rows inserted; duplicates are skipped. */
  insertPassages(transcriptId: string, passages: NotetakerPassageRecord[]): Promise<number>;
  countPassages(transcriptId: string): Promise<number>;
  /** Returns passages with index greater than the cursor, ordered by index ascending. */
  findPassagesPage(params: {
    transcriptId: string;
    cursor: number | null;
    limit: number;
  }): Promise<NotetakerPassageRecord[]>;
  findAllPassages(transcriptId: string): Promise<NotetakerPassageRecord[]>;
  findLastPassageEndMs(transcriptId: string): Promise<number | null>;
  update(
    id: string,
    data: Partial<
      Pick<NotetakerTranscriptRecord, "language" | "completeness" | "durationMs" | "passageCount">
    >
  ): Promise<NotetakerTranscriptRecord>;
  deleteById(id: string): Promise<void>;
  deleteByBookingId(bookingId: number): Promise<number>;
}
