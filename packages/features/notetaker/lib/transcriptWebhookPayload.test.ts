import { describe, expect, it } from "vitest";
import type { NotetakerSummaryRecord } from "../repositories/interfaces/INotetakerSummaryRepository";
import type {
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";
import { buildNotetakerTranscriptWebhookPayload } from "./transcriptWebhookPayload";

const buildTranscript = (overrides: Partial<NotetakerTranscriptRecord> = {}): NotetakerTranscriptRecord => ({
  id: "transcript-1",
  sessionId: "session-1",
  bookingId: 1,
  language: "en",
  completeness: "COMPLETE",
  durationMs: 60000,
  passageCount: 2,
  speakerNamesAvailable: true,
  createdAt: new Date("2026-11-04T10:00:00.000Z"),
  ...overrides,
});

const buildPassage = (overrides: Partial<NotetakerPassageRecord> = {}): NotetakerPassageRecord => ({
  index: 0,
  speakerKey: "s1",
  speakerName: "Anna",
  unknownSpeakerNumber: null,
  startMs: 0,
  endMs: 1000,
  text: "hello",
  language: "en",
  ...overrides,
});

const buildSummary = (overrides: Partial<NotetakerSummaryRecord> = {}): NotetakerSummaryRecord => ({
  id: "summary-1",
  transcriptId: "transcript-1",
  status: "READY",
  language: "en",
  overview: "Overview",
  keyPoints: ["point"],
  decisions: ["decision"],
  topics: [{ title: "Topic", category: "UPDATE", details: ["detail"] }],
  formatVersion: 2,
  actionItems: [{ text: "do it", owner: "Anna" }],
  model: "model",
  attempts: 1,
  failureCode: null,
  generatedAt: new Date("2026-11-04T10:05:00.000Z"),
  ...overrides,
});

describe("buildNotetakerTranscriptWebhookPayload", () => {
  it("passes the TRUNCATED completeness through", () => {
    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript({ completeness: "TRUNCATED" }),
      passages: [],
      summary: null,
    });

    expect(payload.completeness).toBe("TRUNCATED");
  });

  it("maps the transcript fields and drops internal ones", () => {
    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript({ language: null, completeness: "PARTIAL", speakerNamesAvailable: null }),
      passages: [buildPassage()],
      summary: null,
    });

    expect(payload).toEqual({
      version: 1,
      sessionId: "session-1",
      transcriptId: "transcript-1",
      language: null,
      completeness: "PARTIAL",
      durationMs: 60000,
      speakerNamesAvailable: null,
      passages: [
        {
          index: 0,
          speakerKey: "s1",
          speakerName: "Anna",
          unknownSpeakerNumber: null,
          startMs: 0,
          endMs: 1000,
          text: "hello",
        },
      ],
      summary: null,
    });
  });

  it("sorts passages by index without mutating the input", () => {
    const passages = [buildPassage({ index: 2 }), buildPassage({ index: 0 }), buildPassage({ index: 1 })];

    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript(),
      passages,
      summary: null,
    });

    expect(payload.passages.map((passage) => passage.index)).toEqual([0, 1, 2]);
    expect(passages.map((passage) => passage.index)).toEqual([2, 0, 1]);
  });

  it("passes unknownSpeakerNumber through for unnamed speakers", () => {
    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript(),
      passages: [buildPassage({ speakerName: null, unknownSpeakerNumber: 3 })],
      summary: null,
    });

    expect(payload.passages[0]).toMatchObject({ speakerName: null, unknownSpeakerNumber: 3 });
    expect(payload.passages[0]).not.toHaveProperty("language");
  });

  it("includes a READY summary with its arrays", () => {
    const summary = buildSummary();

    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript(),
      passages: [buildPassage()],
      summary,
    });

    expect(payload.summary).toEqual({
      status: "READY",
      language: "en",
      overview: "Overview",
      keyPoints: ["point"],
      decisions: ["decision"],
      actionItems: [{ text: "do it", owner: "Anna" }],
      topics: [{ title: "Topic", category: "UPDATE", details: ["detail"] }],
    });
  });

  it("includes a FAILED summary", () => {
    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript(),
      passages: [buildPassage()],
      summary: buildSummary({
        status: "FAILED",
        overview: null,
        keyPoints: [],
        decisions: [],
        topics: [],
        actionItems: [],
      }),
    });

    expect(payload.summary).toEqual({
      status: "FAILED",
      language: "en",
      overview: null,
      keyPoints: [],
      decisions: [],
      actionItems: [],
      topics: [],
    });
  });

  it.each(["NOT_ENOUGH_CONTENT", "PENDING"] as const)("sends no summary for %s", (status) => {
    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript(),
      passages: [buildPassage()],
      summary: buildSummary({ status }),
    });

    expect(payload.summary).toBeNull();
  });

  it("sends no summary when none exists", () => {
    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript(),
      passages: [buildPassage()],
      summary: null,
    });

    expect(payload.summary).toBeNull();
  });

  it("falls back to empty arrays when stored JSON is not an array", () => {
    const corrupted = buildSummary({
      keyPoints: null as unknown as string[],
      decisions: {} as unknown as string[],
      actionItems: "x" as unknown as NotetakerSummaryRecord["actionItems"],
      topics: undefined as unknown as NotetakerSummaryRecord["topics"],
    });

    const payload = buildNotetakerTranscriptWebhookPayload({
      transcript: buildTranscript(),
      passages: [buildPassage()],
      summary: corrupted,
    });

    expect(payload.summary).toMatchObject({ keyPoints: [], decisions: [], actionItems: [], topics: [] });
  });
});
