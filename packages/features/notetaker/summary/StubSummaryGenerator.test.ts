import { notetakerSummaryContentSchema } from "@calcom/lib/dto/NotetakerSummaryDto";
import { describe, expect, it, vi } from "vitest";
import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";
import type { NotetakerSummaryResult } from "./INotetakerSummaryGenerator";
import { STUB_SUMMARY_MODEL, StubSummaryGenerator } from "./StubSummaryGenerator";

function buildPassage(overrides: Partial<NotetakerPassageRecord> = {}): NotetakerPassageRecord {
  return {
    index: 0,
    speakerKey: "speaker-1",
    speakerName: "Alex",
    unknownSpeakerNumber: null,
    startMs: 0,
    endMs: 1000,
    text: "hello",
    language: "en",
    ...overrides,
  };
}

async function generateContent(
  passages: NotetakerPassageRecord[],
  languageHint: string | null = null
): Promise<Extract<NotetakerSummaryResult, { ok: true }>> {
  const result = await new StubSummaryGenerator().generate({ passages, languageHint });
  if (!result.ok) {
    throw new Error(`Expected an ok result but got ${result.failureCode}`);
  }
  return result;
}

describe("StubSummaryGenerator", () => {
  it("returns an ok result with the stub model", async () => {
    const result = await new StubSummaryGenerator().generate({
      passages: [buildPassage()],
      languageHint: null,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.model).toBe("stub");
    expect(STUB_SUMMARY_MODEL).toBe("stub");
  });

  it("returns equal output for the same input twice", async () => {
    const passages = [
      buildPassage({ index: 0, text: "We decided to ship" }),
      buildPassage({ index: 1, speakerName: "Sam", text: "Sam will send the notes" }),
    ];
    const generator = new StubSummaryGenerator();

    const first = await generator.generate({ passages, languageHint: "pl" });
    const second = await generator.generate({ passages, languageHint: "pl" });
    const fromOtherInstance = await new StubSummaryGenerator().generate({ passages, languageHint: "pl" });

    expect(second).toEqual(first);
    expect(fromOtherInstance).toEqual(first);
  });

  it("produces content that passes notetakerSummaryContentSchema", async () => {
    const { content } = await generateContent([
      buildPassage({ index: 0, text: "Welcome everyone" }),
      buildPassage({
        index: 1,
        speakerKey: "speaker-2",
        speakerName: null,
        unknownSpeakerNumber: 1,
        text: "We decided to move the launch",
      }),
      buildPassage({ index: 2, speakerName: "Sam", speakerKey: "speaker-3", text: "Action: book a room" }),
    ]);

    expect(notetakerSummaryContentSchema.safeParse(content).success).toBe(true);
  });

  it("passes the schema for an empty passage list", async () => {
    const { content } = await generateContent([]);

    expect(content).toEqual({ language: "en", overview: "", keyPoints: [], decisions: [], actionItems: [] });
    expect(notetakerSummaryContentSchema.safeParse(content).success).toBe(true);
  });

  it("uses the language hint over passage languages", async () => {
    const { content } = await generateContent([buildPassage({ language: "en" })], "pl");

    expect(content.language).toBe("pl");
  });

  it("falls back to the first non-null passage language", async () => {
    const { content } = await generateContent(
      [
        buildPassage({ index: 0, language: null }),
        buildPassage({ index: 1, language: "de" }),
        buildPassage({ index: 2, language: "en" }),
      ],
      null
    );

    expect(content.language).toBe("de");
  });

  it("falls back to en when no language is known", async () => {
    const { content } = await generateContent([buildPassage({ language: null })], null);

    expect(content.language).toBe("en");
  });

  it("builds the overview from the first three passages joined with spaces", async () => {
    const { content } = await generateContent([
      buildPassage({ index: 0, text: "t0" }),
      buildPassage({ index: 1, text: "t1" }),
      buildPassage({ index: 2, text: "t2" }),
      buildPassage({ index: 3, text: "t3" }),
    ]);

    expect(content.overview).toBe("t0 t1 t2");
    expect(content.overview).not.toContain("t3");
  });

  it("cuts the overview to 300 characters", async () => {
    const texts = ["a".repeat(200), "b".repeat(200), "c".repeat(200)];
    const { content } = await generateContent(texts.map((text, index) => buildPassage({ index, text })));

    expect(content.overview).toHaveLength(300);
    expect(content.overview).toBe(texts.join(" ").slice(0, 300));
  });

  it("lists one key point per distinct speaker label with that speaker's first text", async () => {
    const { content } = await generateContent([
      buildPassage({ index: 0, speakerName: "Alex", text: "first alex" }),
      buildPassage({ index: 1, speakerName: "Alex", text: "second alex" }),
      buildPassage({ index: 2, speakerKey: "speaker-2", speakerName: "Sam", text: "sam speaks" }),
    ]);

    expect(content.keyPoints).toEqual(["Alex: first alex", "Sam: sam speaks"]);
  });

  it("labels an unnamed speaker by number", async () => {
    const { content } = await generateContent([
      buildPassage({ speakerName: null, unknownSpeakerNumber: 2, text: "who am i" }),
    ]);

    expect(content.keyPoints).toEqual(["Speaker 2: who am i"]);
  });

  it("keeps at most three key points", async () => {
    const names = ["Alex", "Sam", "Kim", "Lee"];
    const { content } = await generateContent(
      names.map((speakerName, index) =>
        buildPassage({ index, speakerKey: `speaker-${index}`, speakerName, text: `text ${index}` })
      )
    );

    expect(content.keyPoints).toEqual(["Alex: text 0", "Sam: text 1", "Kim: text 2"]);
  });

  it("only looks at the first ten passages for key points", async () => {
    const passages = Array.from({ length: 10 }, (_, index) =>
      buildPassage({ index, speakerName: "Alex", text: `alex ${index}` })
    );
    passages.push(buildPassage({ index: 10, speakerKey: "speaker-2", speakerName: "Sam", text: "late" }));

    const { content } = await generateContent(passages);

    expect(content.keyPoints).toEqual(["Alex: alex 0"]);
  });

  it("cuts each key point to 120 characters", async () => {
    const { content } = await generateContent([buildPassage({ text: "x".repeat(200) })]);

    expect(content.keyPoints).toHaveLength(1);
    expect(content.keyPoints[0]).toHaveLength(120);
    expect(content.keyPoints[0].startsWith("Alex: ")).toBe(true);
  });

  it("collects decisions case-insensitively, at most three", async () => {
    const texts = [
      "We DECIDED to ship on Friday",
      "I agree with the plan",
      "Agreed",
      "Also decided on the budget",
      "Nothing relevant here",
    ];
    const { content } = await generateContent(texts.map((text, index) => buildPassage({ index, text })));

    expect(content.decisions).toEqual(["We DECIDED to ship on Friday", "I agree with the plan", "Agreed"]);
  });

  it("collects action items with the speaker name as owner, at most three", async () => {
    const { content } = await generateContent([
      buildPassage({ index: 0, speakerName: "Sam", text: "Sam will send the notes" }),
      buildPassage({ index: 1, speakerName: "Sam", text: "Sam is willing to help" }),
      buildPassage({
        index: 2,
        speakerKey: "speaker-2",
        speakerName: null,
        unknownSpeakerNumber: 1,
        text: "Action: book a room",
      }),
      buildPassage({ index: 3, speakerName: "Ada", speakerKey: "speaker-3", text: "Ada will review it" }),
      buildPassage({ index: 4, speakerName: "Pat", speakerKey: "speaker-4", text: "Pat will call them" }),
    ]);

    expect(content.actionItems).toEqual([
      { text: "Sam will send the notes", owner: "Sam" },
      { text: "Action: book a room", owner: null },
      { text: "Ada will review it", owner: "Ada" },
    ]);
  });

  it("logs nothing", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    try {
      await generateContent([buildPassage({ text: "We decided that Sam will go" })]);

      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }

    // A constructor parameter would be an injected logger.
    expect(StubSummaryGenerator.length).toBe(0);
  });
});
