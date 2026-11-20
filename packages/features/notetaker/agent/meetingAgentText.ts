export const MEETING_AGENT_NAME = "BlueBeeBot";

const DEFAULT_CHAT_MESSAGE_MAX_LENGTH = 500;
const DEFAULT_CHAT_MESSAGE_MAX_PARTS = 4;
const TRUNCATION_MARK = "…";

// Tolerates the spellings speech-to-text produces for the name ("Blue Bee Bot", "Blu be bot", ...)
// but only at the very start, so merely mentioning the bot mid-sentence never triggers it.
// A string rather than a literal because a regex literal with the `u` flag does not compile under the ES5 target.
const TRIGGER_PATTERN_SOURCE =
  "^[\\s\\p{P}\\p{S}]*blue?[\\s\\-_.]*b(?:ee|e|i|y)[\\s\\-_.]*bot(?![\\p{L}\\p{N}])[\\s\\p{P}]*";
const TRIGGER_PATTERN: RegExp = new RegExp(TRIGGER_PATTERN_SOURCE, "iu");

const HTML_ENTITIES: ReadonlyArray<[RegExp, string]> = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&nbsp;/g, " "],
  // Decoded last so "&amp;lt;" becomes the literal "&lt;" instead of "<".
  [/&amp;/g, "&"],
];

const SPLIT_LEVELS: ReadonlyArray<{ pattern: RegExp; joiner: string }> = [
  { pattern: /\n\s*\n/, joiner: "\n\n" },
  { pattern: /(?<=[.!?…])\s+/, joiner: " " },
  { pattern: /\s+/, joiner: " " },
];

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseMeetingAgentTrigger(text: string): { command: string } | null {
  const match = TRIGGER_PATTERN.exec(text);
  if (!match) return null;
  return { command: text.slice(match[0].length).trim() };
}

export function chatMessageToPlainText(raw: string): string {
  // Teams delivers chat messages as HTML fragments.
  let text = raw.replace(/<[^>]*>/g, " ");
  for (const [pattern, replacement] of HTML_ENTITIES) {
    text = text.replace(pattern, replacement);
  }
  return collapseWhitespace(text);
}

export function utteranceWordsToText(words: ReadonlyArray<{ text: string }>): string {
  return collapseWhitespace(words.map((word) => word.text).join(" "));
}

// A reply starting with the bot's name would be parsed as a new command when echoed back via chat.
export function stripLeadingAgentName(text: string): string {
  let result = text.trim();
  let match = TRIGGER_PATTERN.exec(result);
  while (match && match[0].length > 0) {
    result = result.slice(match[0].length).trim();
    match = TRIGGER_PATTERN.exec(result);
  }
  return result;
}

function packUnits(units: string[], joiner: string, maxLength: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current === "") {
      current = unit;
      continue;
    }
    const candidate = `${current}${joiner}${unit}`;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    parts.push(current);
    current = unit;
  }
  if (current !== "") parts.push(current);
  return parts;
}

function hardCut(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += maxLength) {
    parts.push(text.slice(start, start + maxLength));
  }
  return parts;
}

function splitToFit(text: string, maxLength: number, level: number = 0): string[] {
  if (text.length <= maxLength) return [text];
  if (level >= SPLIT_LEVELS.length) return hardCut(text, maxLength);

  const { pattern, joiner } = SPLIT_LEVELS[level];
  const units = text
    .split(pattern)
    .map((unit) => unit.trim())
    .filter((unit) => unit !== "")
    .flatMap((unit) => splitToFit(unit, maxLength, level + 1));
  return packUnits(units, joiner, maxLength);
}

function withTruncationMark(text: string, maxLength: number): string {
  const room = maxLength - TRUNCATION_MARK.length;
  if (text.length <= room) return `${text}${TRUNCATION_MARK}`;

  const cut = text.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  // Prefer ending on a word boundary, unless that would throw away most of the part.
  if (lastSpace > room / 2) return `${cut.slice(0, lastSpace).trimEnd()}${TRUNCATION_MARK}`;
  return `${cut.trimEnd()}${TRUNCATION_MARK}`;
}

export function splitChatMessage(
  text: string,
  maxLength: number = DEFAULT_CHAT_MESSAGE_MAX_LENGTH,
  maxParts: number = DEFAULT_CHAT_MESSAGE_MAX_PARTS
): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const parts = splitToFit(trimmed, maxLength);
  if (parts.length <= maxParts) return parts;

  const kept = parts.slice(0, maxParts);
  kept[maxParts - 1] = withTruncationMark(kept[maxParts - 1], maxLength);
  return kept;
}
