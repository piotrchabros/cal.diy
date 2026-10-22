import type { NotetakerExportDocument, NotetakerExportInput, NotetakerExportSection } from "./exportDocument";
import { buildNotetakerExportDocument, buildNotetakerExportFilename } from "./exportDocument";

// A string rather than a literal because a regex literal with the `u` flag does not compile under the ES5 target.
const CONTROL_CHARACTERS_PATTERN = "[\\p{Cc}\\u2028\\u2029]+";
const CONTROL_CHARACTERS: RegExp = new RegExp(CONTROL_CHARACTERS_PATTERN, "gu");
const MARKDOWN_SPECIAL: RegExp = /[\\`*_{}[\]()<>#+\-.!|~]/g;

// Names, titles and summary text are controlled by meeting participants or derived from them, so none may
// start a new Markdown block or form a link.
export function escapeMarkdown(text: string): string {
  return text.replace(CONTROL_CHARACTERS, " ").trim().replace(MARKDOWN_SPECIAL, "\\$&");
}

const bullets = (items: string[]): string => items.map((item) => `- ${escapeMarkdown(item)}`).join("\n");

function renderSection(section: NotetakerExportSection): string[] {
  const blocks = [`### ${section.heading}`];
  switch (section.kind) {
    case "paragraph":
      blocks.push(escapeMarkdown(section.text));
      break;
    case "list":
      blocks.push(bullets(section.items));
      break;
    case "groups":
      for (const group of section.groups) {
        blocks.push(`#### ${escapeMarkdown(group.heading)}`, bullets(group.items));
      }
      break;
    case "topics":
      for (const topic of section.topics) {
        const suffix = topic.categoryLabel === null ? "" : ` · ${topic.categoryLabel}`;
        blocks.push(`#### ${escapeMarkdown(topic.title)}${suffix}`);
        if (topic.details.length > 0) blocks.push(bullets(topic.details));
      }
      break;
  }
  return blocks;
}

export function renderNotetakerMarkdown(doc: NotetakerExportDocument): string {
  const blocks: string[] = [`# ${escapeMarkdown(doc.title)}`, escapeMarkdown(doc.startLine)];
  for (const note of doc.notes) blocks.push(`> ${note}`);

  blocks.push(`## ${doc.summaryHeading}`);
  if (doc.summary === null) {
    blocks.push(doc.noSummary);
  } else {
    for (const section of doc.summary) blocks.push(...renderSection(section));
  }

  blocks.push(`## ${doc.transcriptHeading}`);
  for (const passage of doc.transcript) {
    blocks.push(
      `**[${passage.timestamp}] ${escapeMarkdown(passage.speaker)}:** ${escapeMarkdown(passage.text)}`
    );
  }

  return `${blocks.join("\n\n")}\n`;
}

export function exportMarkdown(input: NotetakerExportInput): { filename: string; content: string } {
  return {
    filename: buildNotetakerExportFilename({
      bookingTitle: input.bookingTitle,
      bookingStartTime: input.bookingStartTime,
      timeZone: input.timeZone,
      extension: "md",
    }),
    content: renderNotetakerMarkdown(buildNotetakerExportDocument(input)),
  };
}
