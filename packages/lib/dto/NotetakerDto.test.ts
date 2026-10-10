import { describe, expect, it } from "vitest";
import type { NotetakerActivityDto, NotetakerSharingChangeDetailDto } from "./NotetakerActivityDto";
import { NotetakerActivityDtoSchema, NotetakerSharingChangeDetailDtoSchema } from "./NotetakerActivityDto";
import type { NotetakerEventTypeSharingDto } from "./NotetakerEventTypeSharingDto";
import {
  NotetakerEventTypeSharingDtoSchema,
  NotetakerSharingModeDtoSchema,
} from "./NotetakerEventTypeSharingDto";
import type { NotetakerSharedResultDto } from "./NotetakerSharedResultDto";
import { NotetakerSharedResultDtoSchema } from "./NotetakerSharedResultDto";
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

describe("NotetakerActivityDtoSchema actions", () => {
  const base: NotetakerActivityDto = {
    id: "activity-1",
    action: "ENABLED",
    actorType: "USER",
    actorName: null,
    createdAt: "2026-03-04T10:15:00.000Z",
    detail: null,
  };

  it.each([
    "ENABLED",
    "DISABLED",
    "STOPPED",
    "SHARED",
    "SHARING_REVOKED",
    "EXPORTED",
    "DELETED",
    "SUMMARY_REQUESTED",
    "SHARED_VIEWED",
    "SHARING_MODE_CHANGED",
    "SHARING_PEOPLE_CHANGED",
  ] as const)("accepts %s", (action) => {
    expect(NotetakerActivityDtoSchema.parse({ ...base, action }).action).toBe(action);
  });
});

describe("NotetakerSharingChangeDetailDtoSchema", () => {
  const valid: NotetakerSharingChangeDetailDto = {
    previousMode: "HOSTS_ONLY",
    newMode: "SELECTED_PEOPLE",
    addedUserNames: ["Alice"],
    removedUserNames: [],
  };

  it("parses a valid object", () => {
    expect(NotetakerSharingChangeDetailDtoSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown mode", () => {
    const invalid: unknown = { ...valid, newMode: "EVERYONE" };
    expect(NotetakerSharingChangeDetailDtoSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a missing name list", () => {
    const { addedUserNames: _omitted, ...rest } = valid;
    expect(NotetakerSharingChangeDetailDtoSchema.safeParse(rest).success).toBe(false);
  });
});

describe("NotetakerSharingModeDtoSchema", () => {
  it("accepts the three modes and rejects others", () => {
    for (const mode of ["HOSTS_ONLY", "TEAM", "SELECTED_PEOPLE"]) {
      expect(NotetakerSharingModeDtoSchema.parse(mode)).toBe(mode);
    }
    expect(NotetakerSharingModeDtoSchema.safeParse("ALL").success).toBe(false);
  });
});

describe("NotetakerEventTypeSharingDtoSchema", () => {
  const valid: NotetakerEventTypeSharingDto = {
    eventTypeId: 7,
    available: true,
    unavailableReason: null,
    mode: "SELECTED_PEOPLE",
    teamName: "Sales",
    people: [{ userId: 3, name: null, email: "a@example.com", avatarUrl: null, stillEligible: true }],
    setAt: "2026-03-04T10:15:00.000Z",
    setByName: "Alice",
  };

  it("parses a valid object", () => {
    expect(NotetakerEventTypeSharingDtoSchema.parse(valid)).toEqual(valid);
  });

  it("parses an unavailable event type", () => {
    const unavailable: NotetakerEventTypeSharingDto = {
      ...valid,
      available: false,
      unavailableReason: "NOT_A_TEAM_EVENT_TYPE",
      mode: "HOSTS_ONLY",
      teamName: null,
      people: [],
      setAt: null,
      setByName: null,
    };
    expect(NotetakerEventTypeSharingDtoSchema.parse(unavailable)).toEqual(unavailable);
  });

  it("rejects an unknown unavailable reason", () => {
    const invalid: unknown = { ...valid, unavailableReason: "OTHER" };
    expect(NotetakerEventTypeSharingDtoSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a person without an email", () => {
    const invalid: unknown = {
      ...valid,
      people: [{ userId: 3, name: null, avatarUrl: null, stillEligible: true }],
    };
    expect(NotetakerEventTypeSharingDtoSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("NotetakerSharedResultDtoSchema", () => {
  const valid: NotetakerSharedResultDto = {
    bookingUid: "uid-1",
    title: "Weekly sync",
    startTime: "2026-03-04T10:15:00.000Z",
    eventTypeTitle: "Sync",
    teamName: "Sales",
    hostName: null,
    route: "TEAM",
    summaryStatus: "READY",
  };

  it("parses a valid object", () => {
    expect(NotetakerSharedResultDtoSchema.parse(valid)).toEqual(valid);
  });

  it("parses a null summary status", () => {
    const noSummary: NotetakerSharedResultDto = { ...valid, summaryStatus: null };
    expect(NotetakerSharedResultDtoSchema.parse(noSummary)).toEqual(noSummary);
  });

  it("rejects the HOSTS_ONLY route", () => {
    const invalid: unknown = { ...valid, route: "HOSTS_ONLY" };
    expect(NotetakerSharedResultDtoSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("NotetakerTranscriptDtoSchema speakerNamesAvailable", () => {
  const base: NotetakerTranscriptDto = {
    id: "transcript-1",
    language: null,
    completeness: "COMPLETE",
    durationMs: 1000,
    passageCount: 1,
  };

  it.each([true, false, null])("accepts %s", (speakerNamesAvailable) => {
    const dto: NotetakerTranscriptDto = { ...base, speakerNamesAvailable };
    expect(NotetakerTranscriptDtoSchema.parse(dto)).toEqual(dto);
  });

  it("stays valid when absent", () => {
    expect(NotetakerTranscriptDtoSchema.parse(base)).toEqual(base);
  });
});
