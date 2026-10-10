import { describe, expect, it } from "vitest";
import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";
import { buildSpeakerRoster, DEFAULT_UNKNOWN_SPEAKER_LABEL, getSpeakerLabel } from "./speakerLabel";

const buildPassage = (overrides: Partial<NotetakerPassageRecord>): NotetakerPassageRecord => ({
  index: 0,
  speakerKey: "participant:a",
  speakerName: null,
  unknownSpeakerNumber: null,
  startMs: 0,
  endMs: 1000,
  text: "hello",
  language: null,
  ...overrides,
});

describe("getSpeakerLabel", () => {
  it("prefers the speaker name", () => {
    expect(getSpeakerLabel({ speakerName: "Alex", unknownSpeakerNumber: 3 })).toBe("Alex");
  });

  it("numbers an unnamed speaker with the default wording", () => {
    expect(getSpeakerLabel({ speakerName: null, unknownSpeakerNumber: 2 })).toBe("Unknown speaker 2");
    expect(DEFAULT_UNKNOWN_SPEAKER_LABEL(5)).toBe("Unknown speaker 5");
  });

  it("falls back to number 0 when the number is missing", () => {
    expect(getSpeakerLabel({ speakerName: null, unknownSpeakerNumber: null })).toBe("Unknown speaker 0");
  });

  it("uses the supplied wording", () => {
    expect(getSpeakerLabel({ speakerName: null, unknownSpeakerNumber: 1 }, (n) => `Nieznany ${n}`)).toBe(
      "Nieznany 1"
    );
  });
});

describe("buildSpeakerRoster", () => {
  it("gives an empty roster for no passages", () => {
    expect(buildSpeakerRoster([])).toEqual([]);
  });

  it("lists one line per speaker key in order of first appearance", () => {
    const roster = buildSpeakerRoster([
      buildPassage({ speakerKey: "participant:b", speakerName: "Sam" }),
      buildPassage({ speakerKey: "participant:a", speakerName: "Alex" }),
      buildPassage({ speakerKey: "participant:b", speakerName: "Sam" }),
    ]);
    expect(roster).toEqual(["Sam", "Alex"]);
  });

  it("lists both names of a participant who was renamed during the meeting", () => {
    const roster = buildSpeakerRoster([
      buildPassage({ speakerKey: "participant:a", speakerName: "Alex" }),
      buildPassage({ speakerKey: "participant:a", speakerName: "Alex Example" }),
      buildPassage({ speakerKey: "participant:a", speakerName: "Alex" }),
    ]);
    expect(roster).toEqual(["Alex, Alex Example"]);
  });

  it("uses the shared wording for unknown voices", () => {
    const roster = buildSpeakerRoster([
      buildPassage({ speakerKey: "unknown:1", unknownSpeakerNumber: 1 }),
      buildPassage({ speakerKey: "unknown:2", unknownSpeakerNumber: 2 }),
    ]);
    expect(roster).toEqual(["Unknown speaker 1", "Unknown speaker 2"]);
  });
});
