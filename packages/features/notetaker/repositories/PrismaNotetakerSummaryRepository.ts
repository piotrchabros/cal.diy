import { notetakerSummaryContentSchema } from "@calcom/lib/dto/NotetakerSummaryDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type {
  INotetakerSummaryRepository,
  NotetakerSummaryRecord,
} from "./interfaces/INotetakerSummaryRepository";

const summarySelect = {
  id: true,
  transcriptId: true,
  status: true,
  language: true,
  overview: true,
  keyPoints: true,
  decisions: true,
  actionItems: true,
  model: true,
  attempts: true,
  failureCode: true,
  generatedAt: true,
} satisfies Prisma.NotetakerSummarySelect;

// PENDING and FAILED rows have no language/overview, so only the JSON columns are validated.
const summaryJsonColumnsSchema = notetakerSummaryContentSchema.pick({
  keyPoints: true,
  decisions: true,
  actionItems: true,
});

export class PrismaNotetakerSummaryRepository implements INotetakerSummaryRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findByTranscriptId(transcriptId: string): Promise<NotetakerSummaryRecord | null> {
    const row = await this.prismaClient.notetakerSummary.findUnique({
      where: { transcriptId },
      select: summarySelect,
    });
    if (!row) return null;
    return this.toRecord(row);
  }

  async upsertPending(transcriptId: string): Promise<NotetakerSummaryRecord> {
    const row = await this.prismaClient.notetakerSummary.upsert({
      where: { transcriptId },
      create: { transcriptId },
      update: { status: "PENDING", failureCode: null },
      select: summarySelect,
    });
    return this.toRecord(row);
  }

  async incrementAttempts(transcriptId: string): Promise<number> {
    const row = await this.prismaClient.notetakerSummary.update({
      where: { transcriptId },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return row.attempts;
  }

  async saveResult(
    transcriptId: string,
    data: Pick<
      NotetakerSummaryRecord,
      "status" | "language" | "overview" | "keyPoints" | "decisions" | "actionItems" | "model" | "generatedAt"
    >
  ): Promise<NotetakerSummaryRecord> {
    const parsed = summaryJsonColumnsSchema.safeParse({
      keyPoints: data.keyPoints,
      decisions: data.decisions,
      actionItems: data.actionItems,
    });
    if (!parsed.success) {
      throw ErrorWithCode.Factory.BadRequest(
        `Invalid notetaker summary content for transcript ${transcriptId}`
      );
    }

    const row = await this.prismaClient.notetakerSummary.update({
      where: { transcriptId },
      data: {
        status: data.status,
        language: data.language,
        overview: data.overview,
        keyPoints: parsed.data.keyPoints,
        decisions: parsed.data.decisions,
        actionItems: parsed.data.actionItems,
        model: data.model,
        generatedAt: data.generatedAt,
      },
      select: summarySelect,
    });
    return this.toRecord(row);
  }

  async setStatus(
    transcriptId: string,
    status: NotetakerSummaryRecord["status"],
    failureCode: string | null
  ): Promise<void> {
    await this.prismaClient.notetakerSummary.update({
      where: { transcriptId },
      data: { status, failureCode },
      select: { id: true },
    });
  }

  private toRecord(
    row: Prisma.NotetakerSummaryGetPayload<{ select: typeof summarySelect }>
  ): NotetakerSummaryRecord {
    const parsed = summaryJsonColumnsSchema.safeParse({
      keyPoints: row.keyPoints,
      decisions: row.decisions,
      actionItems: row.actionItems,
    });
    if (!parsed.success) {
      throw ErrorWithCode.Factory.InternalServerError(
        `Stored notetaker summary for transcript ${row.transcriptId} has malformed JSON columns`
      );
    }

    return {
      id: row.id,
      transcriptId: row.transcriptId,
      status: row.status,
      language: row.language,
      overview: row.overview,
      keyPoints: parsed.data.keyPoints,
      decisions: parsed.data.decisions,
      actionItems: parsed.data.actionItems,
      model: row.model,
      attempts: row.attempts,
      failureCode: row.failureCode,
      generatedAt: row.generatedAt,
    };
  }
}
