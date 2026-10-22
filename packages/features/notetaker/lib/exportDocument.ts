import type {
  NotetakerSummaryDto,
  NotetakerSummaryTopicCategoryDto,
} from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerPassageDto, NotetakerTranscriptDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { groupActionItemsByOwner } from "@calcom/lib/notetaker/groupActionItemsByOwner";
import { getSpeakerLabel } from "./speakerLabel";

// A string rather than a literal because a regex literal with the `u` flag does not compile under the ES5 target.
const COMBINING_MARKS_PATTERN = "\\p{M}+";
const COMBINING_MARKS: RegExp = new RegExp(COMBINING_MARKS_PATTERN, "gu");

// NFKD does not decompose these letters into a base plus a combining mark, so they would otherwise be dropped.
const TRANSLITERATIONS: Record<string, string> = {
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  ø: "o",
  Ø: "O",
  ß: "ss",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
};
const TRANSLITERATION_PATTERN: RegExp = new RegExp(`[${Object.keys(TRANSLITERATIONS).join("")}]`, "g");

const MAX_SLUG_LENGTH = 60;

const pad2 = (value: number): string => String(value).padStart(2, "0");

export type NotetakerExportLabels = {
  summaryHeading: string;
  overviewHeading: string;
  keyPointsHeading: string;
  decisionsHeading: string;
  actionItemsHeading: string;
  keyFindingsHeading: string;
  nextStepsHeading: string;
  keyTopicsHeading: string;
  unassignedOwner: string;
  topicCategory: Record<NotetakerSummaryTopicCategoryDto, string>;
  transcriptHeading: string;
  noSummary: string;
  partialNote: string;
  truncatedNote: string;
  speakerNamesUnavailableNote: string;
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

export type NotetakerExportTopic = {
  title: string;
  category: NotetakerSummaryTopicCategoryDto | null;
  categoryLabel: string | null;
  details: string[];
};

export type NotetakerExportSection =
  | { kind: "paragraph"; heading: string; text: string }
  | { kind: "list"; heading: string; items: string[] }
  | { kind: "groups"; heading: string; groups: { heading: string; items: string[] }[] }
  | { kind: "topics"; heading: string; topics: NotetakerExportTopic[] };

// Every string is raw: each renderer escapes for its own output format.
export type NotetakerExportDocument = {
  title: string;
  startLine: string;
  lang: string;
  notes: string[];
  summaryHeading: string;
  summary: NotetakerExportSection[] | null;
  noSummary: string;
  transcriptHeading: string;
  transcript: { timestamp: string; speaker: string; text: string }[];
};

export type NotetakerExportExtension = "md" | "html" | "pdf";

export function resolveTimeZone(timeZone: string): string {
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
  extension: NotetakerExportExtension;
}): string {
  const slug = params.bookingTitle
    .replace(TRANSLITERATION_PATTERN, (letter) => TRANSLITERATIONS[letter] ?? letter)
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

  return `${slug === "" ? "transcript" : slug}-${part("year")}-${part("month")}-${part("day")}.${params.extension}`;
}

function buildActionItemsSection(
  heading: string,
  summary: NotetakerSummaryDto,
  labels: NotetakerExportLabels
): NotetakerExportSection | null {
  const groups = groupActionItemsByOwner(summary.actionItems);
  if (groups.length === 0) return null;
  return {
    kind: "groups",
    heading,
    groups: groups.map((group) => ({ heading: group.owner ?? labels.unassignedOwner, items: group.items })),
  };
}

function buildSummarySections(
  summary: NotetakerSummaryDto | null,
  labels: NotetakerExportLabels
): NotetakerExportSection[] | null {
  if (summary?.status !== "READY") return null;

  const isV2 = summary.formatVersion === 2;
  const sections: NotetakerExportSection[] = [];

  if (summary.overview !== null && summary.overview.trim() !== "") {
    sections.push({ kind: "paragraph", heading: labels.overviewHeading, text: summary.overview });
  }
  if (summary.keyPoints.length > 0) {
    sections.push({
      kind: "list",
      heading: isV2 ? labels.keyFindingsHeading : labels.keyPointsHeading,
      items: summary.keyPoints,
    });
  }
  // Version 2 moved decisions into topics; a stray stored list is not shown, matching the results page.
  if (!isV2 && summary.decisions.length > 0) {
    sections.push({ kind: "list", heading: labels.decisionsHeading, items: summary.decisions });
  }
  const actionItems = buildActionItemsSection(
    isV2 ? labels.nextStepsHeading : labels.actionItemsHeading,
    summary,
    labels
  );
  if (actionItems !== null) sections.push(actionItems);
  if (isV2 && summary.topics.length > 0) {
    sections.push({
      kind: "topics",
      heading: labels.keyTopicsHeading,
      topics: summary.topics.map((topic) => ({
        title: topic.title,
        category: topic.category,
        categoryLabel: topic.category === null ? null : labels.topicCategory[topic.category],
        details: topic.details,
      })),
    });
  }

  return sections.length > 0 ? sections : null;
}

export function buildNotetakerExportDocument(input: NotetakerExportInput): NotetakerExportDocument {
  const { labels } = input;
  const lang = resolveLocale(input.locale);
  const startLine = new Intl.DateTimeFormat(lang, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: resolveTimeZone(input.timeZone),
  }).format(input.bookingStartTime);

  const notes: string[] = [];
  if (input.transcript.completeness === "PARTIAL") notes.push(labels.partialNote);
  if (input.transcript.completeness === "TRUNCATED") notes.push(labels.truncatedNote);
  if (input.transcript.speakerNamesAvailable === false) notes.push(labels.speakerNamesUnavailableNote);

  const transcript = [...input.passages]
    .sort((a, b) => a.index - b.index)
    .map((passage) => ({
      timestamp: formatExportTimestamp(passage.startMs),
      speaker: getSpeakerLabel(passage, labels.unknownSpeaker),
      text: passage.text,
    }));

  return {
    title: input.bookingTitle,
    startLine,
    lang,
    notes,
    summaryHeading: labels.summaryHeading,
    summary: buildSummarySections(input.summary, labels),
    noSummary: labels.noSummary,
    transcriptHeading: labels.transcriptHeading,
    transcript,
  };
}
