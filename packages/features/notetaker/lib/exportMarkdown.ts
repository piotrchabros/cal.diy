import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerPassageDto, NotetakerTranscriptDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { getSpeakerLabel } from "./speakerLabel";

// Strings rather than literals because a regex literal with the `u` flag does not compile under the ES5 target.
const COMBINING_MARKS_PATTERN = "\\p{M}+";
const CONTROL_CHARACTERS_PATTERN = "[\\p{Cc}\\u2028\\u2029]+";
const COMBINING_MARKS: RegExp = new RegExp(COMBINING_MARKS_PATTERN, "gu");
const CONTROL_CHARACTERS: RegExp = new RegExp(CONTROL_CHARACTERS_PATTERN, "gu");
const MARKDOWN_SPECIAL: RegExp = /[\\`*_{}[\]()<>#+\-.!|~]/g;

const MAX_SLUG_LENGTH = 60;

const pad2 = (value: number): string => String(value).padStart(2, "0");

function resolveTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch (error) {
    if (error instanceof RangeError) return "UTC";
    throw error;
  }
}

function resolveLocale(locale: string): string {
  try {
    new Intl.DateTimeFormat(locale);
    return locale;
  } catch (error) {
    if (error instanceof RangeError) return "en";
    throw error;
  }
}

function buildSummaryBlocks(summary: NotetakerSummaryDto | null, labels: NotetakerExportLabels): string[] {
  if (summary?.status !== "READY") return [labels.noSummary];

  const blocks: string[] = [];
  if (summary.overview !== null && summary.overview.trim() !== "") {
    blocks.push(`### ${labels.overviewHeading}`, escapeMarkdown(summary.overview));
  }
  if (summary.keyPoints.length > 0) {
    blocks.push(
      `### ${labels.keyPointsHeading}`,
      summary.keyPoints.map((item) => `- ${escapeMarkdown(item)}`).join("\n")
    );
  }
  if (summary.decisions.length > 0) {
    blocks.push(
      `### ${labels.decisionsHeading}`,
      summary.decisions.map((item) => `- ${escapeMarkdown(item)}`).join("\n")
    );
  }
  if (summary.actionItems.length > 0) {
    const items = summary.actionItems.map((item) => {
      const owner = item.owner === null ? "" : ` (${escapeMarkdown(labels.owner(item.owner))})`;
      return `- ${escapeMarkdown(item.text)}${owner}`;
    });
    blocks.push(`### ${labels.actionItemsHeading}`, items.join("\n"));
  }
  return blocks.length > 0 ? blocks : [labels.noSummary];
}

export type NotetakerExportLabels = {
  summaryHeading: string;
  overviewHeading: string;
  keyPointsHeading: string;
  decisionsHeading: string;
  actionItemsHeading: string;
  transcriptHeading: string;
  noSummary: string;
  partialNote: string;
  truncatedNote: string;
  speakerNamesUnavailableNote: string;
  owner: (name: string) => string;
  unknownSpeaker: (number: number) => string;
};

export type NotetakerExportInput = {
  bookingTitle: string;
  bookingStartTime: Date;
  locale: string;
  timeZone: string;
  summary: NotetakerSummaryDto | null;
  transcript: Pick<NotetakerTranscriptDto, "completeness" | "speakerNamesAvailable">;
  passages: NotetakerPassageDto[];
  labels: NotetakerExportLabels;
};

// Names, titles and summary text are controlled by meeting participants or derived from them, so none may
// start a new Markdown block or form a link.
export function escapeMarkdown(text: string): string {
  return text.replace(CONTROL_CHARACTERS, " ").trim().replace(MARKDOWN_SPECIAL, "\\$&");
}

export function formatExportTimestamp(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

export function buildNotetakerExportFilename(params: {
  bookingTitle: string;
  bookingStartTime: Date;
  timeZone: string;
}): string {
  const slug = params.bookingTitle
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(params.timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(params.bookingStartTime);
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${slug === "" ? "transcript" : slug}-${part("year")}-${part("month")}-${part("day")}.md`;
}

export function exportMarkdown(input: NotetakerExportInput): { filename: string; content: string } {
  const { labels } = input;
  const timeZone = resolveTimeZone(input.timeZone);
  const startLine = new Intl.DateTimeFormat(resolveLocale(input.locale), {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(input.bookingStartTime);

  const blocks: string[] = [`# ${escapeMarkdown(input.bookingTitle)}`, escapeMarkdown(startLine)];

  if (input.transcript.completeness === "PARTIAL") blocks.push(`> ${labels.partialNote}`);
  if (input.transcript.completeness === "TRUNCATED") blocks.push(`> ${labels.truncatedNote}`);

  if (input.transcript.speakerNamesAvailable === false)
    blocks.push(`> ${labels.speakerNamesUnavailableNote}`);

  blocks.push(`## ${labels.summaryHeading}`, ...buildSummaryBlocks(input.summary, labels));
  blocks.push(`## ${labels.transcriptHeading}`);

  const passages = [...input.passages].sort((a, b) => a.index - b.index);
  for (const passage of passages) {
    const speaker = getSpeakerLabel(passage, labels.unknownSpeaker);
    blocks.push(
      `**[${formatExportTimestamp(passage.startMs)}] ${escapeMarkdown(speaker)}:** ${escapeMarkdown(passage.text)}`
    );
  }

  return {
    filename: buildNotetakerExportFilename({
      bookingTitle: input.bookingTitle,
      bookingStartTime: input.bookingStartTime,
      timeZone,
    }),
    content: `${blocks.join("\n\n")}\n`,
  };
}
