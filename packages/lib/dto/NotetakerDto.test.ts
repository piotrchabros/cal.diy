import { describe, expect, it } from "vitest";
import type { NotetakerActivityDto } from "./NotetakerActivityDto";
import { NotetakerActivityDtoSchema } from "./NotetakerActivityDto";
import type { NotetakerSummaryContent, NotetakerSummaryDto } from "./NotetakerSummaryDto";
import {
  NotetakerSummaryDtoSchema,
  NotetakerSummaryStatusDtoSchema,
  notetakerSummaryContentSchema,
} from "./NotetakerSummaryDto";
import type {
  NotetakerPassageDto,
  NotetakerTranscriptCompletenessDto,
  NotetakerTranscriptDto,
} from "./NotetakerTranscriptDto";
import {
  NotetakerPassageDtoSchema,
  NotetakerTranscriptCompletenessDtoSchema,
  NotetakerTranscriptDtoSchema,
} from "./NotetakerTranscriptDto";

describe("NotetakerTranscriptCompletenessDtoSchema", () => {
  it("parses a valid object", () => {
    const valid: NotetakerTranscriptCompletenessDto = "PARTIAL";
    expect(NotetakerTranscriptCompletenessDtoSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown completeness", () => {
    const invalid: unknown = "FULL";
    expect(NotetakerTranscriptCompletenessDtoSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("NotetakerPassageDtoSchema", () => {
  const valid: NotetakerPassageDto = {
    index: 0,
    speakerName: "Alice",
    unknownSpeakerNumber: null,
    startMs: 0,
    endMs: 1500,
    text: "Hello",
    language: "en",
  };

  it("parses a valid object", () => {
    expect(NotetakerPassageDtoSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a passage with both speaker fields set", () => {
    const invalid: unknown = { ...valid, unknownSpeakerNumber: 1 };
    expect(NotetakerPassageDtoSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a passage with neither speaker field set", () => {
    const invalid: unknown = { ...valid, speakerName: null, unknownSpeakerNumber: null };
    expect(NotetakerPassageDtoSchema.safeParse(invalid).success).toBe(false);
  });

  it("parses a passage with only an unknown speaker number", () => {
    const unknownSpeaker: NotetakerPassageDto = { ...valid, speakerName: null, unknownSpeakerNumber: 2 };
    expect(NotetakerPassageDtoSchema.parse(unknownSpeaker)).toEqual(unknownSpeaker);
  });
});

describe("NotetakerTranscriptDtoSchema", () => {
  const valid: NotetakerTranscriptDto = {
    id: "transcript-1",
    language: null,
    completeness: "COMPLETE",
    durationMs: 60000,
    passageCount: 12,
  };

  it("parses a valid object", () => {
    expect(NotetakerTranscriptDtoSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a negative duration", () => {
    const invalid: unknown = { ...valid, durationMs: -1 };
    expect(NotetakerTranscriptDtoSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("NotetakerSummaryStatusDtoSchema", () => {
  it("parses a valid object", () => {
    const valid = "NOT_ENOUGH_CONTENT";
    expect(NotetakerSummaryStatusDtoSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown status", () => {
    const invalid: unknown = "DONE";
    expect(NotetakerSummaryStatusDtoSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("NotetakerSummaryDtoSchema", () => {
  const valid: NotetakerSummaryDto = {
    status: "READY",
    language: "en",
    overview: "Overview",
    keyPoints: ["Point"],
    decisions: [],
    actionItems: [{ text: "Send notes", owner: null }],
    generatedAt: "2026-03-04T10:15:00.000Z",
  };

  it("parses a valid object", () => {
    expect(NotetakerSummaryDtoSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a generatedAt that is not a datetime", () => {
    const invalid: unknown = { ...valid, generatedAt: "yesterday" };
    expect(NotetakerSummaryDtoSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("notetakerSummaryContentSchema", () => {
  const valid: NotetakerSummaryContent = {
    language: "en",
    overview: "Overview",
    keyPoints: [],
    decisions: ["Ship it"],
    actionItems: [{ text: "Send notes", owner: "Bob" }],
  };

  it("parses a valid object", () => {
    expect(notetakerSummaryContentSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a null language", () => {
    const invalid: unknown = { ...valid, language: null };
    expect(notetakerSummaryContentSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("NotetakerActivityDtoSchema", () => {
  const valid: NotetakerActivityDto = {
    id: "activity-1",
    action: "EXPORTED",
    actorType: "USER",
    actorName: "Alice",
    createdAt: "2026-03-04T10:15:00.000Z",
    detail: { format: "markdown" },
  };

  it("parses a valid object", () => {
    expect(NotetakerActivityDtoSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown action", () => {
    const invalid: unknown = { ...valid, action: "ARCHIVED" };
    expect(NotetakerActivityDtoSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a createdAt without a time component", () => {
    const invalid: unknown = { ...valid, createdAt: "2026-03-04" };
    expect(NotetakerActivityDtoSchema.safeParse(invalid).success).toBe(false);
  });

  it("parses an activity with null detail", () => {
    const noDetail: NotetakerActivityDto = { ...valid, detail: null };
    expect(NotetakerActivityDtoSchema.parse(noDetail)).toEqual(noDetail);
  });
});
