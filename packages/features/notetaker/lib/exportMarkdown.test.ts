import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerPassageDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { describe, expect, it, vi } from "vitest";
import {
  buildNotetakerExportFilename,
  escapeMarkdown,
  exportMarkdown,
  formatExportTimestamp,
  type NotetakerExportInput,
  type NotetakerExportLabels,
} from "./exportMarkdown";

const labels: NotetakerExportLabels = {
  summaryHeading: "Summary",
  overviewHeading: "Overview",
  keyPointsHeading: "Key points",
  decisionsHeading: "Decisions",
  actionItemsHeading: "Action items",
  transcriptHeading: "Transcript",
  noSummary: "No summary is available for this meeting.",
  partialNote: "This transcript is incomplete: the notetaker was removed.",
  truncatedNote: "This transcript was cut off at the maximum length.",
  owner: (name: string) => `Owner: ${name}`,
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
  status: "READY",
  language: "en",
  overview: "We planned the launch.",
  keyPoints: ["Launch in May"],
  decisions: ["Ship v2"],
  actionItems: [
    { text: "Send the notes", owner: "Alex" },
    { text: "Book a room", owner: null },
  ],
  generatedAt: "2026-10-12T10:40:00.000Z",
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

const formatDate = (locale: string, timeZone: string, date = new Date("2026-10-12T10:00:00.000Z")): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone }).format(date);

const expectedDate: string = formatDate("en", "UTC");

const EVIL = "[x](http://evil)";
const EVIL_ESCAPED = "\\[x\\]\\(http://evil\\)";

describe("exportMarkdown", () => {
  it("builds the golden document", () => {
    const { content } = exportMarkdown(
      buildInput({
        passages: [
          buildPassage({
            index: 1,
            speakerName: null,
            unknownSpeakerNumber: 2,
            startMs: 61000,
            text: "Sounds good",
          }),
          buildPassage({ index: 0, speakerName: "Alex", startMs: 1500, text: "Hello everyone" }),
        ],
      })
    );

    const blocks = [
      "# Planning call",
      escapeMarkdown(expectedDate),
      "## Summary",
      "### Overview",
      "We planned the launch\\.",
      "### Key points",
      "- Launch in May",
      "### Decisions",
      "- Ship v2",
      "### Action items",
      "- Send the notes (Owner: Alex)\n- Book a room",
      "## Transcript",
      "**[00:00:01] Alex:** Hello everyone",
      "**[00:01:01] Unknown speaker 2:** Sounds good",
    ];

    expect(content).toBe(`${blocks.join("\n\n")}\n`);
  });

  it("starts with the title line then the date line", () => {
    const lines = exportMarkdown(buildInput()).content.split("\n");
    expect(lines[0]).toBe("# Planning call");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(escapeMarkdown(expectedDate));
    expect(expectedDate).toContain("October");
    expect(expectedDate).toContain("2026");
  });

  it("formats the date in the given zone and locale", () => {
    const tokyo = exportMarkdown(buildInput({ timeZone: "Asia/Tokyo" })).content;
    expect(tokyo).toContain("7:00");

    const warsaw = exportMarkdown(buildInput({ locale: "pl", timeZone: "Europe/Warsaw" })).content;
    expect(warsaw).toContain("12:00");
    expect(warsaw).toContain("2026");
  });

  it("falls back to UTC for an invalid zone and does not throw for an invalid locale", () => {
    const invalid = exportMarkdown(buildInput({ timeZone: "Not/AZone" }));
    const utc = exportMarkdown(buildInput({ timeZone: "UTC" }));
    expect(invalid.content).toBe(utc.content);
    expect(invalid.filename).toBe(utc.filename);

    expect(() => exportMarkdown(buildInput({ locale: "not a locale" }))).not.toThrow();
  });

  it("omits empty summary sections", () => {
    const content = exportMarkdown(
      buildInput({ summary: buildSummary({ overview: null, keyPoints: [], actionItems: [] }) })
    ).content;
    expect(content).not.toContain("### Overview");
    expect(content).not.toContain("### Key points");
    expect(content).not.toContain("### Action items");
    expect(content).toContain("### Decisions");

    const blankOverview = exportMarkdown(buildInput({ summary: buildSummary({ overview: "  " }) })).content;
    expect(blankOverview).not.toContain("### Overview");
  });

  it("prints an owner only where stated and passes the raw name to the label", () => {
    const content = exportMarkdown(buildInput()).content;
    expect(content).toContain("- Send the notes (Owner: Alex)");
    expect(content).toContain("- Book a room\n");
    expect(content).not.toContain("- Book a room (");

    const owner = vi.fn((name: string) => `Owner: ${name}`);
    const escaped = exportMarkdown(
      buildInput({
        summary: buildSummary({ actionItems: [{ text: "Do it", owner: "A*lex" }] }),
        labels: { ...labels, owner },
      })
    ).content;
    expect(owner).toHaveBeenCalledWith("A*lex");
    expect(escaped).toContain("(Owner: A\\*lex)");
  });

  it("prints the no-summary line for a READY summary with nothing to show", () => {
    const content = exportMarkdown(
      buildInput({
        summary: buildSummary({ overview: null, keyPoints: [], decisions: [], actionItems: [] }),
      })
    ).content;
    expect(content).toContain("## Summary\n\nNo summary is available for this meeting.\n\n## Transcript");
  });

  it.each([
    "PENDING",
    "FAILED",
    "NOT_ENOUGH_CONTENT",
  ] as const)("hides summary text for a %s summary", (status) => {
    const content = exportMarkdown(
      buildInput({ summary: buildSummary({ status, overview: "SECRET overview" }) })
    ).content;
    expect(content).toContain("No summary is available for this meeting.");
    expect(content).not.toContain("SECRET");
    expect(content).not.toContain("Launch in May");
    expect(content).not.toContain("###");
  });

  it("prints the no-summary line for a null summary", () => {
    const content = exportMarkdown(buildInput({ summary: null })).content;
    expect(content).toContain("No summary is available for this meeting.");
    expect(content).not.toContain("###");
  });

  it("orders passages by index without mutating the input", () => {
    const passages = [
      buildPassage({ index: 2, text: "third" }),
      buildPassage({ index: 0, text: "first" }),
      buildPassage({ index: 1, text: "second" }),
    ];
    const content = exportMarkdown(buildInput({ passages })).content;
    expect(content.indexOf("first")).toBeLessThan(content.indexOf("second"));
    expect(content.indexOf("second")).toBeLessThan(content.indexOf("third"));
    expect(passages.map((passage) => passage.index)).toEqual([2, 0, 1]);
  });

  it("labels unknown speakers", () => {
    const three = exportMarkdown(
      buildInput({ passages: [buildPassage({ speakerName: null, unknownSpeakerNumber: 3 })] })
    ).content;
    expect(three).toContain("**[00:00:00] Unknown speaker 3:** Hello");

    const none = exportMarkdown(
      buildInput({ passages: [buildPassage({ speakerName: null, unknownSpeakerNumber: null })] })
    ).content;
    expect(none).toContain("Unknown speaker 0");
  });

  it("adds a note for PARTIAL and TRUNCATED transcripts only", () => {
    const partial = exportMarkdown(buildInput({ transcript: { completeness: "PARTIAL" } })).content;
    const date = escapeMarkdown(expectedDate);
    expect(partial).toContain(`${date}\n\n> ${labels.partialNote}\n\n## Summary`);

    const truncated = exportMarkdown(buildInput({ transcript: { completeness: "TRUNCATED" } })).content;
    expect(truncated).toContain(`${date}\n\n> ${labels.truncatedNote}\n\n## Summary`);

    const complete = exportMarkdown(buildInput()).content;
    expect(complete.split("\n").some((line) => line.startsWith("> "))).toBe(false);
  });

  it("adds the speaker names note only when names were unavailable", () => {
    const note = `> ${labels.speakerNamesUnavailableNote}`;
    for (const speakerNamesAvailable of [true, null, undefined]) {
      const content = exportMarkdown(
        buildInput({ transcript: { completeness: "COMPLETE", speakerNamesAvailable } })
      ).content;
      expect(content).not.toContain(note);
    }

    const content = exportMarkdown(
      buildInput({ transcript: { completeness: "PARTIAL", speakerNamesAvailable: false } })
    ).content;
    expect(content).toContain(`> ${labels.partialNote}\n\n${note}\n\n## Summary`);
  });

  it("escapes every dynamic string", () => {
    const sites: [string, Partial<NotetakerExportInput>][] = [
      ["passage text", { passages: [buildPassage({ text: EVIL })] }],
      ["speaker name", { passages: [buildPassage({ speakerName: EVIL })] }],
      ["title", { bookingTitle: EVIL }],
      ["key point", { summary: buildSummary({ keyPoints: [EVIL] }) }],
      ["decision", { summary: buildSummary({ decisions: [EVIL] }) }],
      ["overview", { summary: buildSummary({ overview: EVIL }) }],
      ["action item", { summary: buildSummary({ actionItems: [{ text: EVIL, owner: null }] }) }],
    ];
    for (const [, overrides] of sites) {
      const content = exportMarkdown(buildInput(overrides)).content;
      expect(content).toContain(EVIL_ESCAPED);
      expect(content).not.toContain(EVIL);
    }

    const unknown = exportMarkdown(
      buildInput({
        passages: [buildPassage({ speakerName: null, unknownSpeakerNumber: 1 })],
        labels: { ...labels, unknownSpeaker: () => "*n*" },
      })
    ).content;
    expect(unknown).toContain("**[00:00:00] \\*n\\*:**");
    expect(unknown).not.toContain("] *n*:");
  });

  it("keeps a multi-line passage in one paragraph", () => {
    const content = exportMarkdown(
      buildInput({ passages: [buildPassage({ text: "first\n\n# second\n- third" })] })
    ).content;
    const lines = content.split("\n");
    expect(lines.filter((line) => line.startsWith("**["))).toHaveLength(1);
    expect(content).toContain("first \\# second \\- third");
    expect(lines.some((line) => line.startsWith("# second"))).toBe(false);
    expect(lines.some((line) => line.startsWith("- third"))).toBe(false);
  });

  it("trusts labels", () => {
    const content = exportMarkdown(
      buildInput({ labels: { ...labels, summaryHeading: "Summary (1)" } })
    ).content;
    expect(content).toContain("## Summary (1)");
  });

  it("ends with the transcript heading when there are no passages", () => {
    expect(exportMarkdown(buildInput({ passages: [] })).content.endsWith("## Transcript\n")).toBe(true);
  });

  it("ends with exactly one newline", () => {
    const content = exportMarkdown(buildInput()).content;
    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });

  it("uses the same file name as buildNotetakerExportFilename", () => {
    const input = buildInput({ bookingTitle: "Q&A / Roadmap", timeZone: "Asia/Tokyo" });
    expect(exportMarkdown(input).filename).toBe(
      buildNotetakerExportFilename({
        bookingTitle: input.bookingTitle,
        bookingStartTime: input.bookingStartTime,
        timeZone: input.timeZone,
      })
    );
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

describe("escapeMarkdown", () => {
  it.each([
    ["# Heading", "\\# Heading"],
    ["[x](http://evil)", "\\[x\\]\\(http://evil\\)"],
    ["<script>", "\\<script\\>"],
    ["![img](u)", "\\!\\[img\\]\\(u\\)"],
    ["`code`", "\\`code\\`"],
    ["**b**", "\\*\\*b\\*\\*"],
    ["a\\b", "a\\\\b"],
    ["1. item", "1\\. item"],
    ["a|b ~x~ {y} + -", "a\\|b \\~x\\~ \\{y\\} \\+ \\-"],
    ["line1\r\nline2\n\nline3", "line1 line2 line3"],
    ["tab\there\u0000nul\u007fdel", "tab here nul del"],
    ["a\u0085b\u2028c", "a b c"],
    ["   padded  ", "padded"],
  ])("escapes %j", (input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });
});

describe("buildNotetakerExportFilename", () => {
  const start = new Date("2026-10-12T10:00:00.000Z");
  const build = (bookingTitle: string, timeZone = "UTC", bookingStartTime = start): string =>
    buildNotetakerExportFilename({ bookingTitle, bookingStartTime, timeZone });

  it.each([
    ["Planning call", "planning-call-2026-10-12.md"],
    ["../../etc/passwd", "etc-passwd-2026-10-12.md"],
    ["C:\\x", "c-x-2026-10-12.md"],
    ["He said \"hi\" and 'bye'\u0000\nnext", "he-said-hi-and-bye-next-2026-10-12.md"],
    ["\u{1F389}\u{1F389}", "transcript-2026-10-12.md"],
    ["", "transcript-2026-10-12.md"],
    ["R\u00E9union d'\u00E9quipe", "reunion-d-equipe-2026-10-12.md"],
    [".hidden", "hidden-2026-10-12.md"],
    ["x".repeat(70), `${"x".repeat(60)}-2026-10-12.md`],
    [`${"a".repeat(59)} b c`, `${"a".repeat(59)}-2026-10-12.md`],
  ])("builds a safe name for %j", (title, expected) => {
    const filename = build(title);
    expect(filename).toBe(expected);
    expect(filename).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2}\.md$/);
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
