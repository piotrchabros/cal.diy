import type { NotetakerSummaryTopicCategoryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type {
  NotetakerExportDocument,
  NotetakerExportSection,
  NotetakerExportTopic,
} from "../exportDocument";

// A minimal structural subset of pdfmake's document definition, so this builder stays free of the pdfmake
// dependency; the renderer assigns it to pdfmake's own types, which keeps the two compatible.
export type NotetakerPdfMargin = [number, number, number, number];

export type NotetakerPdfText = {
  text: string | NotetakerPdfContent[];
  style?: string;
  bold?: boolean;
  italics?: boolean;
  color?: string;
  background?: string;
  fontSize?: number;
  margin?: NotetakerPdfMargin;
};

export type NotetakerPdfList = { ul: NotetakerPdfContent[]; margin?: NotetakerPdfMargin };

export type NotetakerPdfStack = {
  stack: NotetakerPdfContent[];
  unbreakable?: boolean;
  margin?: NotetakerPdfMargin;
};

export type NotetakerPdfContent = string | NotetakerPdfText | NotetakerPdfList | NotetakerPdfStack;

export type NotetakerPdfStyle = {
  fontSize?: number;
  bold?: boolean;
  italics?: boolean;
  color?: string;
  margin?: NotetakerPdfMargin;
};

export type NotetakerPdfDocDefinition = {
  pageSize: "A4";
  pageMargins: number;
  defaultStyle: { font: "Roboto"; fontSize: number };
  styles: Record<"title" | "meta" | "h2" | "h3" | "transcript", NotetakerPdfStyle>;
  info: { title: string };
  content: NotetakerPdfContent[];
};

export const NOTETAKER_PDF_BADGE_COLORS: Record<NotetakerSummaryTopicCategoryDto, string> = {
  PROBLEM: "#dc2626",
  UPDATE: "#2563eb",
  DECISION: "#16a34a",
};

// An unbreakable block taller than the remaining page is moved to the next page and, when taller than a
// whole page, overflows it, so only topics short enough to always fit are kept together.
const UNBREAKABLE_TOPIC_MAX_DETAILS = 6;

// Non-breaking spaces keep the padding attached to the label, so a line wrap cannot drop or split it.
const BADGE_PADDING = "\u00a0\u00a0";

// Control characters from transcripts or the model have no glyph in the font; \n and \t carry layout.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARACTERS: RegExp = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function stripPdfControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, "");
}

const clean = stripPdfControlCharacters;

const renderList = (items: string[]): NotetakerPdfList => ({
  ul: items.map(clean),
  margin: [0, 0, 0, 8],
});

function renderTopic(topic: NotetakerExportTopic): NotetakerPdfStack {
  const heading: NotetakerPdfContent[] = [{ text: clean(topic.title), bold: true }];
  if (topic.category !== null && topic.categoryLabel !== null) {
    heading.push("  ", {
      text: `${BADGE_PADDING}${clean(topic.categoryLabel)}${BADGE_PADDING}`,
      background: NOTETAKER_PDF_BADGE_COLORS[topic.category],
      color: "#ffffff",
      bold: true,
      fontSize: 8,
    });
  }
  const stack: NotetakerPdfContent[] = [{ text: heading, margin: [0, 6, 0, 2] }];
  if (topic.details.length > 0) stack.push(renderList(topic.details));
  return { stack, unbreakable: topic.details.length <= UNBREAKABLE_TOPIC_MAX_DETAILS };
}

function renderSection(section: NotetakerExportSection): NotetakerPdfContent[] {
  const heading: NotetakerPdfText = { text: clean(section.heading), style: "h3" };
  switch (section.kind) {
    case "paragraph":
      return [heading, { text: clean(section.text), margin: [0, 0, 0, 8] }];
    case "list":
      return [heading, renderList(section.items)];
    case "groups":
      return [
        heading,
        ...section.groups.flatMap((group): NotetakerPdfContent[] => [
          { text: clean(group.heading), bold: true, margin: [0, 4, 0, 2] },
          renderList(group.items),
        ]),
      ];
    case "topics":
      return [heading, ...section.topics.map(renderTopic)];
  }
}

export function buildNotetakerPdfDefinition(document: NotetakerExportDocument): NotetakerPdfDocDefinition {
  const content: NotetakerPdfContent[] = [
    { text: clean(document.title), style: "title" },
    { text: clean(document.startLine), style: "meta" },
    ...document.notes.map(
      (note): NotetakerPdfText => ({
        text: clean(note),
        italics: true,
        color: "#374151",
        margin: [0, 0, 0, 4],
      })
    ),
    { text: clean(document.summaryHeading), style: "h2" },
    ...(document.summary === null
      ? [{ text: clean(document.noSummary), margin: [0, 0, 0, 8] } satisfies NotetakerPdfText]
      : document.summary.flatMap(renderSection)),
    { text: clean(document.transcriptHeading), style: "h2" },
    ...document.transcript.map(
      (passage): NotetakerPdfText => ({
        text: [
          { text: `[${clean(passage.timestamp)}] `, color: "#6b7280" },
          { text: clean(passage.speaker), bold: true },
          `: ${clean(passage.text)}`,
        ],
        style: "transcript",
      })
    ),
  ];

  return {
    pageSize: "A4",
    pageMargins: 40,
    defaultStyle: { font: "Roboto", fontSize: 10 },
    styles: {
      title: { fontSize: 20, bold: true, margin: [0, 0, 0, 4] },
      meta: { color: "#4b5563", margin: [0, 0, 0, 8] },
      h2: { fontSize: 15, bold: true, margin: [0, 16, 0, 6] },
      h3: { fontSize: 12, bold: true, margin: [0, 10, 0, 4] },
      transcript: { fontSize: 9, margin: [0, 0, 0, 4] },
    },
    info: { title: clean(document.title) },
    content,
  };
}
