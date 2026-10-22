import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { PrismaNotetakerSummaryRepository } from "./PrismaNotetakerSummaryRepository";

type SummaryRow = {
  id: string;
  transcriptId: string;
  status: "READY";
  language: string | null;
  overview: string | null;
  keyPoints: unknown;
  decisions: unknown;
  topics: unknown;
  formatVersion: number;
  actionItems: unknown;
  model: string | null;
  attempts: number;
  failureCode: string | null;
  generatedAt: Date | null;
};

const generatedAt = new Date("2026-03-04T10:15:00.000Z");

function buildRow(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    id: "summary-1",
    transcriptId: "transcript-1",
    status: "READY",
    language: "en",
    overview: "Overview",
    keyPoints: ["Point"],
    decisions: ["Ship it"],
    topics: [],
    formatVersion: 1,
    actionItems: [{ text: "Send notes", owner: null }],
    model: "stub",
    attempts: 1,
    failureCode: null,
    generatedAt,
    ...overrides,
  };
}

function buildRepository(row: SummaryRow | null) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const update = vi.fn().mockResolvedValue(row);
  const prismaClient = { notetakerSummary: { findUnique, update } } as unknown as PrismaClient;
  return { repository: new PrismaNotetakerSummaryRepository(prismaClient), findUnique, update };
}

describe("PrismaNotetakerSummaryRepository", () => {
  it("reads a version 1 row with no topics", async () => {
    const { repository } = buildRepository(buildRow());

    const record = await repository.findByTranscriptId("transcript-1");

    expect(record?.formatVersion).toBe(1);
    expect(record?.topics).toEqual([]);
    expect(record?.decisions).toEqual(["Ship it"]);
  });

  it("reads a version 2 row with topics", async () => {
    const topics = [{ title: "Pricing", category: "DECISION", details: ["Keep the plan"] }];
    const { repository } = buildRepository(buildRow({ formatVersion: 2, decisions: [], topics }));

    const record = await repository.findByTranscriptId("transcript-1");

    expect(record?.formatVersion).toBe(2);
    expect(record?.topics).toEqual(topics);
  });

  it("returns null when the summary does not exist", async () => {
    const { repository } = buildRepository(null);

    expect(await repository.findByTranscriptId("missing")).toBeNull();
  });

  it("throws on an unknown format version", async () => {
    const { repository } = buildRepository(buildRow({ formatVersion: 3 }));

    await expect(repository.findByTranscriptId("transcript-1")).rejects.toThrow(/format version 3/);
  });

  it("throws on malformed topics", async () => {
    const { repository } = buildRepository(buildRow({ topics: [{ title: "No details" }] }));

    await expect(repository.findByTranscriptId("transcript-1")).rejects.toThrow(/malformed JSON/);
  });

  it("writes topics and formatVersion on saveResult", async () => {
    const topics = [{ title: "Pricing", category: null, details: [] }];
    const { repository, update } = buildRepository(buildRow({ formatVersion: 2, topics }));

    await repository.saveResult("transcript-1", {
      status: "READY",
      language: "en",
      overview: "Overview",
      keyPoints: ["Point"],
      decisions: [],
      actionItems: [],
      topics: [{ title: "Pricing", category: null, details: [] }],
      formatVersion: 2,
      model: "stub",
      generatedAt,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { transcriptId: "transcript-1" },
        data: expect.objectContaining({ topics, formatVersion: 2 }),
      })
    );
  });
});
