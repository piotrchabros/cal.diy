import { describe, expect, it } from "vitest";
import type { NotetakerExportDocument, NotetakerExportTopic } from "../exportDocument";
import {
  buildNotetakerPdfDefinition,
  NOTETAKER_PDF_BADGE_COLORS,
  type NotetakerPdfContent,
  type NotetakerPdfStack,
  type NotetakerPdfText,
} from "./exportPdfDefinition";

const topics: NotetakerExportTopic[] = [
  {
    title: "Pricing",
    category: "PROBLEM",
    categoryLabel: "Problem",
    details: ["Too expensive", "Competitors are cheaper"],
  },
  { title: "Roadmap", category: "UPDATE", categoryLabel: "Update", details: ["Beta in June"] },
  { title: "Vendor", category: "DECISION", categoryLabel: "Decision", details: ["Go with Acme"] },
  { title: "Misc", category: null, categoryLabel: null, details: ["Lunch"] },
];

const buildDoc = (overrides: Partial<NotetakerExportDocument> = {}): NotetakerExportDocument => ({
  title: "Planning call",
  startLine: "Monday, October 12, 2026 at 10:00 AM",
  lang: "en",
  notes: [],
  summaryHeading: "Summary",
  summary: [
    { kind: "paragraph", heading: "Overview", text: "We planned the launch." },
    { kind: "list", heading: "Key findings and agreements", items: ["Launch in May"] },
    {
      kind: "groups",
      heading: "Next steps",
      groups: [
        { heading: "Alex", items: ["Send the notes"] },
        { heading: "Unassigned", items: ["Book a room"] },
      ],
    },
    { kind: "topics", heading: "Key topics", topics },
  ],
  noSummary: "No summary is available for this meeting.",
  transcriptHeading: "Transcript",
  transcript: [{ timestamp: "00:00:01", speaker: "Alex", text: "Hello everyone" }],
  ...overrides,
});

function collectStrings(content: NotetakerPdfContent | NotetakerPdfContent[]): string[] {
  if (Array.isArray(content)) return content.flatMap(collectStrings);
  if (typeof content === "string") return [content];
  if ("text" in content) return collectStrings(content.text);
  if ("ul" in content) return collectStrings(content.ul);
  return collectStrings(content.stack);
}

const textOf = (content: NotetakerPdfContent | NotetakerPdfContent[]): string =>
  collectStrings(content).join("");

const isText = (content: NotetakerPdfContent): content is NotetakerPdfText =>
  typeof content !== "string" && "text" in content;

const isStack = (content: NotetakerPdfContent): content is NotetakerPdfStack =>
  typeof content !== "string" && "stack" in content;

const styled = (content: NotetakerPdfContent[], style: string): string[] =>
  content.filter(isText).flatMap((item) => (item.style === style ? [textOf(item)] : []));

function badgeRuns(stack: NotetakerPdfStack): NotetakerPdfText[] {
  const [heading] = stack.stack;
  if (heading === undefined || !isText(heading) || typeof heading.text === "string") return [];
  return heading.text.filter(isText).filter((run) => run.background !== undefined);
}

describe("buildNotetakerPdfDefinition", () => {
  it("sets the page, fonts, styles and document title", () => {
    const definition = buildNotetakerPdfDefinition(buildDoc());
    expect(definition.pageSize).toBe("A4");
    expect(definition.pageMargins).toBe(40);
    expect(definition.defaultStyle).toEqual({ font: "Roboto", fontSize: 10 });
    expect(Object.keys(definition.styles).sort()).toEqual(["h2", "h3", "meta", "title", "transcript"]);
    expect(definition.styles.transcript.fontSize).toBe(9);
    expect(definition.info.title).toBe("Planning call");
  });

  it("renders the title, start line and notes in italics", () => {
    const { content } = buildNotetakerPdfDefinition(buildDoc({ notes: ["Partial transcript"] }));
    expect(content[0]).toEqual({ text: "Planning call", style: "title" });
    expect(content[1]).toEqual({ text: "Monday, October 12, 2026 at 10:00 AM", style: "meta" });
    expect(content[2]).toMatchObject({ text: "Partial transcript", italics: true });
  });

  it("renders version 2 sections in order", () => {
    const { content } = buildNotetakerPdfDefinition(buildDoc());
    expect(styled(content, "h2")).toEqual(["Summary", "Transcript"]);
    expect(styled(content, "h3")).toEqual([
      "Overview",
      "Key findings and agreements",
      "Next steps",
      "Key topics",
    ]);
    const flat = textOf(content);
    const order = [
      "Overview",
      "We planned the launch.",
      "Launch in May",
      "Alex",
      "Send the notes",
      "Book a room",
    ].map((text) => flat.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("renders version 1 sections in order", () => {
    const { content } = buildNotetakerPdfDefinition(
      buildDoc({
        summary: [
          { kind: "paragraph", heading: "Overview", text: "Short call." },
          { kind: "list", heading: "Key points", items: ["Point A"] },
          { kind: "list", heading: "Decisions", items: ["Decision A"] },
          { kind: "groups", heading: "Action items", groups: [{ heading: "Alex", items: ["Do it"] }] },
        ],
      })
    );
    expect(styled(content, "h3")).toEqual(["Overview", "Key points", "Decisions", "Action items"]);
    const groupHeading = content.find((item) => isText(item) && item.text === "Alex");
    expect(groupHeading).toMatchObject({ bold: true });
    expect(content).toContainEqual(expect.objectContaining({ ul: ["Decision A"] }));
  });

  it("renders every topic with a coloured badge and all details", () => {
    const { content } = buildNotetakerPdfDefinition(buildDoc());
    const stacks = content.filter(isStack);
    expect(stacks).toHaveLength(topics.length);

    topics.forEach((topic, index) => {
      const stack = stacks[index];
      expect(textOf(stack)).toContain(topic.title);
      expect(stack.stack[1]).toEqual(expect.objectContaining({ ul: topic.details }));
      expect(stack.unbreakable).toBe(true);
      const badges = badgeRuns(stack);
      if (topic.category === null) {
        expect(badges).toEqual([]);
        return;
      }
      expect(badges).toHaveLength(1);
      expect(textOf(badges[0]).trim()).toBe(topic.categoryLabel);
      expect(badges[0]).toMatchObject({
        background: NOTETAKER_PDF_BADGE_COLORS[topic.category],
        color: "#ffffff",
        bold: true,
        fontSize: 8,
      });
    });
    expect(NOTETAKER_PDF_BADGE_COLORS).toEqual({
      PROBLEM: "#dc2626",
      UPDATE: "#2563eb",
      DECISION: "#16a34a",
    });
  });

  it("lets a long topic break across pages", () => {
    const longTopic: NotetakerExportTopic = {
      title: "Long",
      category: "UPDATE",
      categoryLabel: "Update",
      details: Array.from({ length: 20 }, (_, index) => `Detail ${index}`),
    };
    const { content } = buildNotetakerPdfDefinition(
      buildDoc({ summary: [{ kind: "topics", heading: "Key topics", topics: [longTopic] }] })
    );
    expect(content.filter(isStack)[0].unbreakable).toBe(false);
  });

  it("renders the no-summary text when there is no summary", () => {
    const { content } = buildNotetakerPdfDefinition(buildDoc({ summary: null }));
    expect(textOf(content)).toContain("No summary is available for this meeting.");
    expect(styled(content, "h3")).toEqual([]);
  });

  it("formats one transcript line per passage", () => {
    const { content } = buildNotetakerPdfDefinition(
      buildDoc({
        transcript: [
          { timestamp: "00:00:01", speaker: "Alex", text: "Hello everyone" },
          { timestamp: "01:02:03", speaker: "Sam", text: "Hi" },
        ],
      })
    );
    const lines = content.filter(
      (item): item is NotetakerPdfText => isText(item) && item.style === "transcript"
    );
    expect(lines.map(textOf)).toEqual(["[00:00:01] Alex: Hello everyone", "[01:02:03] Sam: Hi"]);
    expect(lines[0].text).toContainEqual({ text: "Alex", bold: true });
  });

  it("strips control characters except newlines and tabs", () => {
    const { content, info } = buildNotetakerPdfDefinition(
      buildDoc({
        title: "Plan\u0000ning\u0007 call",
        transcript: [
          { timestamp: "00:00:01", speaker: "Al\u001bex", text: "Line one\nLine\ttwo\u007f\u0085" },
        ],
      })
    );
    expect(info.title).toBe("Planning call");
    expect(textOf(content)).toContain("[00:00:01] Alex: Line one\nLine\ttwo");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserts that no control character survives
    expect(textOf(content)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("keeps Polish text untouched", () => {
    const polish = "Zażółć gęślą jaźń. Łódź, Świętokrzyskie, Ćma, Ńa";
    const { content, info } = buildNotetakerPdfDefinition(
      buildDoc({ title: polish, transcript: [{ timestamp: "00:00:01", speaker: "Łukasz", text: polish }] })
    );
    expect(info.title).toBe(polish);
    expect(textOf(content)).toContain(`[00:00:01] Łukasz: ${polish}`);
  });
});
