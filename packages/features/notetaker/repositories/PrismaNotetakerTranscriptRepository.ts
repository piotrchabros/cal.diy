import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type {
  INotetakerTranscriptRepository,
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "./interfaces/INotetakerTranscriptRepository";

const transcriptSelect = {
  id: true,
  sessionId: true,
  bookingId: true,
  language: true,
  completeness: true,
  durationMs: true,
  passageCount: true,
  createdAt: true,
} satisfies Prisma.NotetakerTranscriptSelect;

const passageSelect = {
  index: true,
  speakerKey: true,
  speakerName: true,
  unknownSpeakerNumber: true,
  startMs: true,
  endMs: true,
  text: true,
  language: true,
} satisfies Prisma.NotetakerTranscriptPassageSelect;

export class PrismaNotetakerTranscriptRepository implements INotetakerTranscriptRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findBySessionId(sessionId: string): Promise<NotetakerTranscriptRecord | null> {
    return await this.prismaClient.notetakerTranscript.findUnique({
      where: { sessionId },
      select: transcriptSelect,
    });
  }

  async findById(id: string): Promise<NotetakerTranscriptRecord | null> {
    return await this.prismaClient.notetakerTranscript.findUnique({
      where: { id },
      select: transcriptSelect,
    });
  }

  async findIdsByBookingId(bookingId: number): Promise<{ id: string; sessionId: string }[]> {
    return await this.prismaClient.notetakerTranscript.findMany({
      where: { bookingId },
      select: { id: true, sessionId: true },
    });
  }

  async createIfMissing(data: { sessionId: string; bookingId: number }): Promise<NotetakerTranscriptRecord> {
    return await this.prismaClient.notetakerTranscript.upsert({
      where: { sessionId: data.sessionId },
      create: { sessionId: data.sessionId, bookingId: data.bookingId },
      update: {},
      select: transcriptSelect,
    });
  }

  async insertPassages(transcriptId: string, passages: NotetakerPassageRecord[]): Promise<number> {
    if (passages.length === 0) return 0;

    // Fields are mapped explicitly so extra keys on a parsed bot passage cannot reach the insert.
    const result = await this.prismaClient.notetakerTranscriptPassage.createMany({
      data: passages.map((passage) => ({
        transcriptId,
        index: passage.index,
        speakerKey: passage.speakerKey,
        speakerName: passage.speakerName,
        unknownSpeakerNumber: passage.unknownSpeakerNumber,
        startMs: passage.startMs,
        endMs: passage.endMs,
        text: passage.text,
        language: passage.language,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async countPassages(transcriptId: string): Promise<number> {
    return await this.prismaClient.notetakerTranscriptPassage.count({ where: { transcriptId } });
  }

  async findPassagesPage({
    transcriptId,
    cursor,
    limit,
  }: {
    transcriptId: string;
    cursor: number | null;
    limit: number;
  }): Promise<NotetakerPassageRecord[]> {
    return await this.prismaClient.notetakerTranscriptPassage.findMany({
      where: { transcriptId, ...(cursor !== null ? { index: { gt: cursor } } : {}) },
      orderBy: { index: "asc" },
      take: limit,
      select: passageSelect,
    });
  }

  async findAllPassages(transcriptId: string): Promise<NotetakerPassageRecord[]> {
    return await this.prismaClient.notetakerTranscriptPassage.findMany({
      where: { transcriptId },
      orderBy: { index: "asc" },
      select: passageSelect,
    });
  }

  async findLastPassageEndMs(transcriptId: string): Promise<number | null> {
    const result = await this.prismaClient.notetakerTranscriptPassage.aggregate({
      where: { transcriptId },
      _max: { endMs: true },
    });
    return result._max.endMs;
  }

  async update(
    id: string,
    data: Partial<
      Pick<NotetakerTranscriptRecord, "language" | "completeness" | "durationMs" | "passageCount">
    >
  ): Promise<NotetakerTranscriptRecord> {
    return await this.prismaClient.notetakerTranscript.update({
      where: { id },
      data: {
        language: data.language,
        completeness: data.completeness,
        durationMs: data.durationMs,
        passageCount: data.passageCount,
      },
      select: transcriptSelect,
    });
  }

  async deleteById(id: string): Promise<void> {
    // deleteMany keeps this idempotent; passages and summary are removed by FK cascade.
    await this.prismaClient.notetakerTranscript.deleteMany({ where: { id } });
  }

  async deleteByBookingId(bookingId: number): Promise<number> {
    const result = await this.prismaClient.notetakerTranscript.deleteMany({ where: { bookingId } });
    return result.count;
  }
}
