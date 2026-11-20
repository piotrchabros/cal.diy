export const MEETING_AGENT_NAME = "BlueBeeBot";

const DEFAULT_CHAT_MESSAGE_MAX_LENGTH = 500;
const DEFAULT_CHAT_MESSAGE_MAX_PARTS = 4;
const TRUNCATION_MARK = "…";
export const MAX_SPOKEN_REPLY_CHARS = 600;

// Tolerates the spellings speech-to-text produces for the name ("Blue Bee Bot", "Blu be bot", ...).
// Patterns are strings rather than literals because a regex literal with the `u` flag does not compile under the ES5 target.
const NAME_STEM_PATTERN_SOURCE = "blue?[\\s\\-_.]*b(?:ee|e|i|y)[\\s\\-_.]*";
const NAME_PATTERN_SOURCE = `${NAME_STEM_PATTERN_SOURCE}bot`;
// Polish speakers inflect the name ("zapytajmy BlueBeeBota", "dzięki BlueBeeBocie").
const INFLECTED_NAME_PATTERN_SOURCE = `${NAME_STEM_PATTERN_SOURCE}(?:bot(?:a|em|owi|y)?|bocie)`;
const WORD_CHAR_CLASS = "[\\p{L}\\p{N}]";
const SPACE_OR_PUNCTUATION_CLASS = "[\\s\\p{P}]";
const SPACE_PUNCTUATION_OR_SYMBOL_CLASS = "[\\s\\p{P}\\p{S}]";
// Leading only: used to sanitise the bot's own outgoing messages.
const TRIGGER_PATTERN_SOURCE = `^${SPACE_PUNCTUATION_OR_SYMBOL_CLASS}*${NAME_PATTERN_SOURCE}(?!${WORD_CHAR_CLASS})${SPACE_OR_PUNCTUATION_CLASS}*`;
const TRIGGER_PATTERN: RegExp = new RegExp(TRIGGER_PATTERN_SOURCE, "iu");
// Whole word anywhere, so "xBlueBeeBot" and "BlueBeeBots" never trigger.
const MENTION_PATTERN: RegExp = new RegExp(
  `(?<!${WORD_CHAR_CLASS})${INFLECTED_NAME_PATTERN_SOURCE}(?!${WORD_CHAR_CLASS})`,
  "iu"
);
const ONLY_PUNCTUATION_PATTERN: RegExp = new RegExp(`^${SPACE_PUNCTUATION_OR_SYMBOL_CLASS}*$`, "u");
const LEADING_PUNCTUATION_PATTERN: RegExp = new RegExp(`^${SPACE_OR_PUNCTUATION_CLASS}+`, "u");
const MEANINGFUL_CHAR_PATTERN: RegExp = new RegExp(WORD_CHAR_CLASS, "u");

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

const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL_PATTERNS: ReadonlyArray<RegExp> = [/\bhttps?:\/\/\S+/gi, /\bwww\.\S+/gi];
const LIST_MARKER_PATTERN = /^\s*(?:[-*•]|\d+[.)])\s+/gm;
const MARKDOWN_SYMBOL_PATTERN = /[*_#`>~|]/g;
const SENTENCE_END_CHARS = ".!?…";

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function removeMention(before: string, after: string): string {
  const head = before.replace(/@$/, "").replace(/[\s,;:\-–—]+$/, "");
  const tail = after.replace(/^[\s,;:\-–—]+/, "");
  const joiner = /^[.!?…]/.test(tail) ? "" : " ";
  return collapseWhitespace(`${head}${joiner}${tail}`);
}

export function parseMeetingAgentTrigger(text: string): { command: string } | null {
  const match = MENTION_PATTERN.exec(text);
  if (!match) return null;

  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const command = ONLY_PUNCTUATION_PATTERN.test(before)
    ? after.replace(LEADING_PUNCTUATION_PATTERN, "").trim()
    : removeMention(before, after);
  return { command: MEANINGFUL_CHAR_PATTERN.test(command) ? command : "" };
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

function truncateSpokenText(text: string, maxChars: number): string {
  const cut = text.slice(0, maxChars);
  for (let index = cut.length - 1; index >= maxChars / 2; index--) {
    if (SENTENCE_END_CHARS.includes(cut[index])) return cut.slice(0, index + 1);
  }

  const room = cut.slice(0, maxChars - TRUNCATION_MARK.length);
  const lastSpace = room.lastIndexOf(" ");
  if (lastSpace > 0) return `${room.slice(0, lastSpace).trimEnd()}${TRUNCATION_MARK}`;
  return `${room}${TRUNCATION_MARK}`;
}

// Text-to-speech reads URLs and markdown symbols literally, so they are dropped rather than spoken.
export function toSpokenText(text: string, maxChars: number = MAX_SPOKEN_REPLY_CHARS): string {
  let spoken = text.replace(MARKDOWN_LINK_PATTERN, "$1");
  for (const pattern of BARE_URL_PATTERNS) {
    spoken = spoken.replace(pattern, " ");
  }
  spoken = spoken.replace(LIST_MARKER_PATTERN, "").replace(MARKDOWN_SYMBOL_PATTERN, "");
  spoken = collapseWhitespace(spoken);
  if (spoken.length <= maxChars) return spoken;
  return truncateSpokenText(spoken, maxChars);
}
