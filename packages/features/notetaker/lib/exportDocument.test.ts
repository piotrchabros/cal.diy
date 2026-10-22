import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerPassageDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { describe, expect, it } from "vitest";
import {
  buildNotetakerExportDocument,
  buildNotetakerExportFilename,
  formatExportTimestamp,
  type NotetakerExportInput,
  type NotetakerExportLabels,
} from "./exportDocument";

const labels: NotetakerExportLabels = {
  summaryHeading: "Summary",
  overviewHeading: "Overview",
  keyPointsHeading: "Key points",
  decisionsHeading: "Decisions",
  actionItemsHeading: "Action items",
  keyFindingsHeading: "Key findings and agreements",
  nextStepsHeading: "Next steps",
  keyTopicsHeading: "Key topics",
  unassignedOwner: "Unassigned",
  topicCategory: { PROBLEM: "Problem", UPDATE: "Update", DECISION: "Decision" },
  transcriptHeading: "Transcript",
  noSummary: "No summary is available for this meeting.",
  partialNote: "This transcript is incomplete.",
  truncatedNote: "This transcript was cut off.",
  speakerNamesUnavailableNote: "Speaker names were not available.",
  unknownSpeaker: (number: number) => `Unknown speaker ${number}`,
};

const buildPassage = (overrides: Partial<NotetakerPassageDto> = {}): NotetakerPassageDto => ({
  index: 0,
  speakerName: "Alex",
  unknownSpeakerNumber: null,
  startMs: 0,
  endMs: 1000,
  text: "Hello",
  language: "en",
  ...overrides,
});

const buildSummary = (overrides: Partial<NotetakerSummaryDto> = {}): NotetakerSummaryDto => ({
  formatVersion: 1,
  status: "READY",
  language: "en",
  overview: "We planned the launch.",
  keyPoints: ["Launch in May"],
  decisions: ["Ship v2"],
  topics: [],
  actionItems: [
    { text: "Book a room", owner: null },
    { text: "Send the notes", owner: "Alex" },
    { text: "Call the venue", owner: "alex" },
    { text: "Draft the plan", owner: "Team Ops" },
  ],
  generatedAt: "2026-10-12T10:40:00.000Z",
  ...overrides,
});

const buildV2Summary = (overrides: Partial<NotetakerSummaryDto> = {}): NotetakerSummaryDto =>
  buildSummary({
    formatVersion: 2,
    decisions: ["Stored decision"],
    topics: [
      { title: "Pricing", category: "PROBLEM", details: ["Too expensive", "Competitors are cheaper"] },
      { title: "Roadmap", category: "UPDATE", details: ["Beta in June"] },
      { title: "Vendor", category: "DECISION", details: ["Go with Acme"] },
      { title: "Misc", category: null, details: [] },
    ],
    ...overrides,
  });

const buildInput = (overrides: Partial<NotetakerExportInput> = {}): NotetakerExportInput => ({
  bookingTitle: "Planning call",
  bookingStartTime: new Date("2026-10-12T10:00:00.000Z"),
  locale: "en",
  timeZone: "UTC",
  summary: buildSummary(),
  transcript: { completeness: "COMPLETE" },
  passages: [buildPassage()],
  labels,
  ...overrides,
});

const expectedGroups = [
  { heading: "Alex", items: ["Send the notes", "Call the venue"] },
  { heading: "Team Ops", items: ["Draft the plan"] },
  { heading: "Unassigned", items: ["Book a room"] },
];

describe("buildNotetakerExportDocument", () => {
  it("builds the version 1 sections in page order", () => {
    const doc = buildNotetakerExportDocument(buildInput());
    expect(doc.summary).toEqual([
      { kind: "paragraph", heading: "Overview", text: "We planned the launch." },
      { kind: "list", heading: "Key points", items: ["Launch in May"] },
      { kind: "list", heading: "Decisions", items: ["Ship v2"] },
      { kind: "groups", heading: "Action items", groups: expectedGroups },
    ]);
  });

  it("builds the version 2 sections in page order without stored decisions", () => {
    const doc = buildNotetakerExportDocument(buildInput({ summary: buildV2Summary() }));
    expect(doc.summary).toEqual([
      { kind: "paragraph", heading: "Overview", text: "We planned the launch." },
      { kind: "list", heading: "Key findings and agreements", items: ["Launch in May"] },
      { kind: "groups", heading: "Next steps", groups: expectedGroups },
      {
        kind: "topics",
        heading: "Key topics",
        topics: [
          {
            title: "Pricing",
            category: "PROBLEM",
            categoryLabel: "Problem",
            details: ["Too expensive", "Competitors are cheaper"],
          },
          { title: "Roadmap", category: "UPDATE", categoryLabel: "Update", details: ["Beta in June"] },
          { title: "Vendor", category: "DECISION", categoryLabel: "Decision", details: ["Go with Acme"] },
          { title: "Misc", category: null, categoryLabel: null, details: [] },
        ],
      },
    ]);
  });

  it("omits empty sections", () => {
    const v1 = buildNotetakerExportDocument(
      buildInput({ summary: buildSummary({ overview: "  ", keyPoints: [], actionItems: [] }) })
    );
    expect(v1.summary?.map((section) => section.heading)).toEqual(["Decisions"]);

    const v2 = buildNotetakerExportDocument(
      buildInput({ summary: buildV2Summary({ overview: null, keyPoints: [], topics: [] }) })
    );
    expect(v2.summary?.map((section) => section.heading)).toEqual(["Next steps"]);
  });

  it("has no summary when a READY summary has nothing to show", () => {
    const doc = buildNotetakerExportDocument(
      buildInput({
        summary: buildV2Summary({ overview: null, keyPoints: [], actionItems: [], topics: [] }),
      })
    );
    expect(doc.summary).toBeNull();
    expect(doc.noSummary).toBe(labels.noSummary);
  });

  it.each([
    "PENDING",
    "FAILED",
    "NOT_ENOUGH_CONTENT",
  ] as const)("has no summary for a %s summary", (status) => {
    expect(
      buildNotetakerExportDocument(buildInput({ summary: buildSummary({ status }) })).summary
    ).toBeNull();
  });

  it("has no summary for a null summary", () => {
    expect(buildNotetakerExportDocument(buildInput({ summary: null })).summary).toBeNull();
  });

  it("adds notes for incomplete transcripts and missing speaker names", () => {
    const notes = (transcript: NotetakerExportInput["transcript"]): string[] =>
      buildNotetakerExportDocument(buildInput({ transcript })).notes;

    expect(notes({ completeness: "COMPLETE" })).toEqual([]);
    expect(notes({ completeness: "COMPLETE", speakerNamesAvailable: null })).toEqual([]);
    expect(notes({ completeness: "PARTIAL" })).toEqual([labels.partialNote]);
    expect(notes({ completeness: "TRUNCATED" })).toEqual([labels.truncatedNote]);
    expect(notes({ completeness: "PARTIAL", speakerNamesAvailable: false })).toEqual([
      labels.partialNote,
      labels.speakerNamesUnavailableNote,
    ]);
  });

  it("orders passages by index and resolves timestamps and speakers", () => {
    const passages = [
      buildPassage({ index: 1, speakerName: null, unknownSpeakerNumber: 2, startMs: 61000, text: "Second" }),
      buildPassage({ index: 0, startMs: 1500, text: "First" }),
    ];
    const doc = buildNotetakerExportDocument(buildInput({ passages }));
    expect(doc.transcript).toEqual([
      { timestamp: "00:00:01", speaker: "Alex", text: "First" },
      { timestamp: "00:01:01", speaker: "Unknown speaker 2", text: "Second" },
    ]);
    expect(passages.map((passage) => passage.index)).toEqual([1, 0]);
  });

  it("keeps text raw and carries the headings, date line and language", () => {
    const doc = buildNotetakerExportDocument(
      buildInput({ bookingTitle: "<b>Call</b>", locale: "pl", timeZone: "Europe/Warsaw" })
    );
    expect(doc.title).toBe("<b>Call</b>");
    expect(doc.lang).toBe("pl");
    expect(doc.startLine).toContain("12:00");
    expect(doc.summaryHeading).toBe("Summary");
    expect(doc.transcriptHeading).toBe("Transcript");
  });

  it("falls back for an invalid zone and locale", () => {
    const doc = buildNotetakerExportDocument(buildInput({ locale: "not a locale", timeZone: "Not/AZone" }));
    expect(doc.lang).toBe("en");
    expect(doc.startLine).toBe(buildNotetakerExportDocument(buildInput()).startLine);
  });
});

describe("formatExportTimestamp", () => {
  it.each([
    [0, "00:00:00"],
    [999, "00:00:00"],
    [61000, "00:01:01"],
    [3723456, "01:02:03"],
    [90000000, "25:00:00"],
    [360000000, "100:00:00"],
    [-5, "00:00:00"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatExportTimestamp(ms)).toBe(expected);
  });
});

describe("buildNotetakerExportFilename", () => {
  const start = new Date("2026-10-12T10:00:00.000Z");
  const build = (
    bookingTitle: string,
    timeZone = "UTC",
    bookingStartTime = start,
    extension: "md" | "html" | "pdf" = "md"
  ): string => buildNotetakerExportFilename({ bookingTitle, bookingStartTime, timeZone, extension });

  it.each([
    ["Planning call", "planning-call-2026-10-12.md"],
    ["../../etc/passwd", "etc-passwd-2026-10-12.md"],
    ["C:\\x", "c-x-2026-10-12.md"],
    ["He said \"hi\" and 'bye'\u0000\nnext", "he-said-hi-and-bye-next-2026-10-12.md"],
    ["\u{1F389}\u{1F389}", "transcript-2026-10-12.md"],
    ["", "transcript-2026-10-12.md"],
    ["R\u00E9union d'\u00E9quipe", "reunion-d-equipe-2026-10-12.md"],
    ["Spotkanie z Łukaszem", "spotkanie-z-lukaszem-2026-10-12.md"],
    ["Zażółć gęślą jaźń", "zazolc-gesla-jazn-2026-10-12.md"],
    ["Đorđe Øre Straße Æble Œuvre", "dorde-ore-strasse-aeble-oeuvre-2026-10-12.md"],
    [".hidden", "hidden-2026-10-12.md"],
    ["x".repeat(70), `${"x".repeat(60)}-2026-10-12.md`],
    [`${"a".repeat(59)} b c`, `${"a".repeat(59)}-2026-10-12.md`],
  ])("builds a safe name for %j", (title, expected) => {
    const filename = build(title);
    expect(filename).toBe(expected);
    expect(filename).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it.each(["md", "html", "pdf"] as const)("uses the %s extension", (extension) => {
    expect(build("Planning call", "UTC", start, extension)).toBe(`planning-call-2026-10-12.${extension}`);
  });

  it("takes the date in the given zone", () => {
    const lateUtc = new Date("2026-10-12T23:30:00.000Z");
    expect(build("Call", "Asia/Tokyo", lateUtc)).toBe("call-2026-10-13.md");
    expect(build("Call", "UTC", lateUtc)).toBe("call-2026-10-12.md");
    expect(build("Call", "America/Los_Angeles", new Date("2026-10-12T02:00:00.000Z"))).toBe(
      "call-2026-10-11.md"
    );
  });

  it("falls back to UTC for an invalid zone", () => {
    const lateUtc = new Date("2026-10-12T23:30:00.000Z");
    expect(build("Call", "Not/AZone", lateUtc)).toBe(build("Call", "UTC", lateUtc));
  });
});
