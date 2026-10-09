// Name redaction for the Meet probe report. Pure and deterministic: no I/O, no clock, no randomness.
// The report is sent by the meeting owner to developers, so the rule is default-deny: with redaction on, a word
// taken from the page reaches the file only when it is a generic UI word or has been replaced by an alias.

import type { NameAliasSummary, StringLocation } from "./meetProbeTypes";

// A name learned whole comes from a page string at a known location or from a speaker event; null also means
// a speaker event, which has neither a location nor a tile.
export type NameSource = StringLocation | "event" | null;

export const UNKNOWN_WORD_PLACEHOLDER = "<x>";

// Generic English words Meet plausibly shows around tiles and call controls. It is an allow-list, so a word
// missing here only turns into "<x>" or a spurious alias. Left out on purpose: every one-letter word, and words
// that are also common given names or surnames (will, may, mark, bill, don, won, can, an, he, she, me, my, do,
// so, no, hang, long, low, block, cam, mike, rose, grace, hope, art, pat).
export const MEET_UI_VOCABULARY: ReadonlySet<string> = new Set(
  [
    "you your yours and is are was were be been being the to of in on off for from with by at as or not yes it its",
    "this that these those has have had does there here now more less other others another all everyone",
    "everybody someone anyone else only also just still when while if than then up down out over into about",
    "after before until again new one their them they our",
    "speaking speaks speak spoke talking muted mute unmute unmuted microphone mic camera video audio sound",
    "speaker speakers presenting presentation present presenter presents screen sharing share shared shares",
    "pinned pin unpin unpinned leave left leaving call calls meeting meetings meet join joined joining joins",
    "ask asked asking admit admitted deny denied remove removed end ended ending return rejoin home turn",
    "turned turning start started stop stopped show hide hidden open opened close closed options option",
    "settings menu actions action controls control button panel tab window dialog tile tiles grid layout",
    "spotlight sidebar fullscreen full main stage view expand collapse minimize maximize picture self",
    "chat message messages send people participant participants guest guests host hosts cohost organizer",
    "moderator external unverified anonymous device devices phone",
    "hand hands raise raised lower lowered reaction reactions emoji captions caption subtitles recording",
    "recorded record transcript transcription transcribing live streaming stream",
    "connection connecting connected reconnecting network quality waiting wait lobby room breakout",
    "info information details help feedback report problem activities tools effects background backgrounds",
    "apply visual name click press select selected use using used available unavailable enabled disabled",
    "active inactive currently already would should could might must cannot isn aren doesn",
    "ok okay cancel got dismiss confirm accept decline allow blocked continue back next done try retry error",
    "failed loading time minutes seconds ago today google workspace account",
  ]
    .join(" ")
    .split(" ")
);

const LOCATION_ORDER: readonly StringLocation[] = ["text", "aria-label", "title", "tooltip"];

// A word is everything that is neither whitespace nor punctuation, so digits, emoji and symbols are words too
// and fall under default-deny (a dial-in participant's display name is a phone number).
const WORD_PATTERN = /[^\s\p{P}+|]+/gu;

// Separators that may sit inside one name ("Jean-Luc", "O'Brien", "J. Smith"); anything else ends the name.
const NAME_INTERNAL_SEPARATOR = /^[\s.'’‐‑-]+$/u;

// "Mute Ada's microphone", "You can't unmute": the letters after the apostrophe are grammar, not a name.
const CLITICS: ReadonlySet<string> = new Set(["s", "t", "re", "ll", "ve"]);
const ENDS_WITH_APOSTROPHE = /['’]$/u;

const HAS_LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/gu;
// "+3" or "2 others" in a tile is a count, not a name; a run of digits this long may be a dial-in number.
const MIN_DIGITS_FOR_NUMERIC_NAME = 5;

const MIN_SECRET_LENGTH = 3;
// Below this length a value is matched as a whole token only, so a name like "Ann" does not hit "channel".
const MIN_SECRET_LENGTH_FOR_SUBSTRING_MATCH = 6;
const TOKEN_CHARACTER = /[\p{L}\p{N}]/u;

type Segment = {
  text: string;
  // The normalised word; null for a separator (a clitic counts as part of the separator).
  word: string | null;
};

type TokenizedString = {
  segments: Segment[];
  // Indices into segments of the words, in order.
  wordAt: number[];
  words: string[];
};

type WordSpan = {
  from: number;
  to: number;
};

type NameEntry = {
  key: string;
  words: string[];
  rawName: string;
  // -1 until the name is first seen in learn order.
  aliasIndex: number;
  // Learned through learnName, so it is matched even when its words are vocabulary words.
  whole: boolean;
  locations: Set<StringLocation>;
  tileKeys: Set<string>;
  inSpeakerEvents: boolean;
};

type PendingLearn =
  | { kind: "name"; entry: NameEntry; where: NameSource; tileKey: string | null }
  | { kind: "tile"; value: string; where: StringLocation; tileKey: string };

type NameMatch = WordSpan & { entry: NameEntry };

const tokenize = (value: string): TokenizedString => {
  const normalized = value.normalize("NFKC");
  const segments: Segment[] = [];
  const wordAt: number[] = [];
  const words: string[] = [];
  let cursor = 0;
  for (const match of normalized.matchAll(WORD_PATTERN)) {
    if (match.index > cursor) segments.push({ text: normalized.slice(cursor, match.index), word: null });
    const text = match[0];
    const word = text.toLowerCase();
    const before = segments[segments.length - 1];
    const beforeThat = segments[segments.length - 2];
    const isClitic =
      CLITICS.has(word) &&
      before !== undefined &&
      before.word === null &&
      ENDS_WITH_APOSTROPHE.test(before.text) &&
      beforeThat !== undefined &&
      beforeThat.word !== null;
    if (isClitic) {
      segments.push({ text, word: null });
    } else {
      wordAt.push(segments.length);
      words.push(word);
      segments.push({ text, word });
    }
    cursor = match.index + text.length;
  }
  if (cursor < normalized.length) segments.push({ text: normalized.slice(cursor), word: null });
  return { segments, wordAt, words };
};

const textBetween = (tokens: TokenizedString, fromWord: number, toWord: number): string => {
  const start = tokens.wordAt[fromWord];
  const end = tokens.wordAt[toWord];
  if (start === undefined || end === undefined) return "";
  return tokens.segments
    .slice(start, end + 1)
    .map((segment) => segment.text)
    .join("");
};

const separatorBetween = (tokens: TokenizedString, leftWord: number, rightWord: number): string => {
  const start = tokens.wordAt[leftWord];
  const end = tokens.wordAt[rightWord];
  if (start === undefined || end === undefined) return "";
  return tokens.segments
    .slice(start + 1, end)
    .map((segment) => segment.text)
    .join("");
};

const byLongestFirst = (a: NameEntry, b: NameEntry): number => {
  if (a.words.length !== b.words.length) return b.words.length - a.words.length;
  if (a.key.length !== b.key.length) return b.key.length - a.key.length;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
};

const isNameLike = (words: string[]): boolean => {
  const joined = words.join("");
  if (HAS_LETTER.test(joined)) return true;
  const digits = joined.match(DIGIT);
  if (digits === null) return true;
  return digits.length >= MIN_DIGITS_FOR_NUMERIC_NAME;
};

export const aliasLabel = (index: number): string => {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Unable to build a participant alias: index ${index} is not a non-negative integer`);
  }
  let letters = "";
  let remaining = index;
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return `Participant ${letters}`;
};

export class NameRedactor {
  private readonly enabled: boolean;
  private readonly entries = new Map<string, NameEntry>();
  private readonly entriesByFirstWord = new Map<string, NameEntry[]>();
  private readonly pending: PendingLearn[] = [];
  private nextAliasIndex = 0;

  constructor(options: { enabled: boolean }) {
    this.enabled = options.enabled;
  }

  learnName(name: string, where: NameSource, tileKey: string | null): void {
    const tokens = tokenize(name);
    if (tokens.words.length === 0) return;
    const entry = this.ensureEntry(tokens.words, name.trim());
    entry.whole = true;
    this.pending.push({ kind: "name", entry, where, tileKey });
  }

  learnTileString(value: string, where: StringLocation, tileKey: string): void {
    this.pending.push({ kind: "tile", value, where, tileKey });
  }

  // Redacting never mints an alias: a run of words that was not learned becomes "<x>", which is just as safe and
  // keeps the names table limited to what the learn pass saw. That makes the tile and the non-tile rewrite the
  // same operation; both methods stay so the caller states which kind of string it holds.
  redactTileString(value: string): string {
    return this.redact(value);
  }

  redactOtherString(value: string): string {
    return this.redact(value);
  }

  summary(): NameAliasSummary[] {
    this.resolvePending();
    return [...this.entries.values()]
      .filter((entry) => entry.aliasIndex >= 0)
      .sort((a, b) => a.aliasIndex - b.aliasIndex)
      .map((entry) => ({
        alias: this.enabled ? aliasLabel(entry.aliasIndex) : entry.rawName,
        locations: LOCATION_ORDER.filter((location) => entry.locations.has(location)),
        tileCount: entry.tileKeys.size,
        inSpeakerEvents: entry.inSpeakerEvents,
      }));
  }

  private redact(value: string): string {
    if (!this.enabled) return value;
    this.resolvePending();
    const tokens = tokenize(value);
    const claimed = tokens.words.map(() => false);
    const matches = this.matchNames(tokens, claimed, false);
    const replacements = new Map<number, { to: number; text: string }>();
    for (const match of matches) {
      replacements.set(match.from, { to: match.to, text: aliasLabel(match.entry.aliasIndex) });
    }
    for (const run of this.unknownRuns(tokens, claimed)) {
      replacements.set(run.from, { to: run.to, text: UNKNOWN_WORD_PLACEHOLDER });
    }

    let output = "";
    let wordPosition = 0;
    let index = 0;
    while (index < tokens.segments.length) {
      const segment = tokens.segments[index];
      if (segment === undefined) break;
      if (segment.word === null) {
        output += segment.text;
        index += 1;
        continue;
      }
      const replacement = replacements.get(wordPosition);
      if (replacement === undefined) {
        output += segment.text;
        index += 1;
        wordPosition += 1;
        continue;
      }
      output += replacement.text;
      index = (tokens.wordAt[replacement.to] ?? index) + 1;
      wordPosition = replacement.to + 1;
    }
    return output;
  }

  // Tile strings are resolved lazily, after every pending learnName is registered, so a name learned whole is
  // recognised inside a tile string even when the report feeds that string first.
  private resolvePending(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    for (const item of batch) {
      if (item.kind === "name") {
        this.touch(item.entry, item.where, item.tileKey);
        continue;
      }
      const tokens = tokenize(item.value);
      const claimed = tokens.words.map(() => false);
      for (const match of this.matchNames(tokens, claimed, true)) {
        this.touch(match.entry, item.where, item.tileKey);
      }
      for (const run of this.unknownRuns(tokens, claimed)) {
        const words = tokens.words.slice(run.from, run.to + 1);
        if (!isNameLike(words)) continue;
        const entry = this.ensureEntry(words, textBetween(tokens, run.from, run.to));
        this.touch(entry, item.where, item.tileKey);
      }
    }
  }

  private ensureEntry(words: string[], rawName: string): NameEntry {
    const key = words.join(" ");
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const entry: NameEntry = {
      key,
      words,
      rawName,
      aliasIndex: -1,
      whole: false,
      locations: new Set(),
      tileKeys: new Set(),
      inSpeakerEvents: false,
    };
    this.entries.set(key, entry);
    const first = words[0];
    if (first !== undefined) {
      const sameFirstWord = this.entriesByFirstWord.get(first);
      if (sameFirstWord === undefined) this.entriesByFirstWord.set(first, [entry]);
      else sameFirstWord.push(entry);
    }
    return entry;
  }

  private touch(entry: NameEntry, where: NameSource, tileKey: string | null): void {
    if (entry.aliasIndex < 0) {
      entry.aliasIndex = this.nextAliasIndex;
      this.nextAliasIndex += 1;
    }
    if (where === null || where === "event") entry.inSpeakerEvents = true;
    else entry.locations.add(where);
    if (tileKey !== null) entry.tileKeys.add(tileKey);
  }

  private matchNames(tokens: TokenizedString, claimed: boolean[], wholeOnly: boolean): NameMatch[] {
    const candidates = new Set<NameEntry>();
    for (const word of tokens.words) {
      for (const entry of this.entriesByFirstWord.get(word) ?? []) {
        if (wholeOnly ? entry.whole : entry.aliasIndex >= 0) candidates.add(entry);
      }
    }
    const matches: NameMatch[] = [];
    for (const entry of [...candidates].sort(byLongestFirst)) {
      const length = entry.words.length;
      let position = 0;
      while (position + length <= tokens.words.length) {
        const fits = entry.words.every(
          (word, offset) => !claimed[position + offset] && tokens.words[position + offset] === word
        );
        if (!fits) {
          position += 1;
          continue;
        }
        for (let offset = 0; offset < length; offset += 1) claimed[position + offset] = true;
        matches.push({ entry, from: position, to: position + length - 1 });
        position += length;
      }
    }
    return matches;
  }

  private unknownRuns(tokens: TokenizedString, claimed: boolean[]): WordSpan[] {
    const isUnknown = (position: number): boolean => {
      const word = tokens.words[position];
      return word !== undefined && !claimed[position] && !MEET_UI_VOCABULARY.has(word);
    };
    const runs: WordSpan[] = [];
    let position = 0;
    while (position < tokens.words.length) {
      if (!isUnknown(position)) {
        position += 1;
        continue;
      }
      let end = position;
      while (isUnknown(end + 1) && NAME_INTERNAL_SEPARATOR.test(separatorBetween(tokens, end, end + 1))) {
        end += 1;
      }
      runs.push({ from: position, to: end });
      position = end + 1;
    }
    return runs;
  }
}

const comparable = (value: string): string => value.normalize("NFKC").toLowerCase();

const JSON_ESCAPE = /\\(?:u[0-9a-f]{4}|[\\"/bfnrt])/g;
const WHITESPACE_RUN = /\s+/g;

// For whole-token matching inside JSON text: an escaped control character ("\n", "\t", "\u0007") ends a word
// just as the character itself does, but its letter would otherwise count as part of the next word.
const tokenComparable = (value: string): string =>
  value
    .replace(JSON_ESCAPE, (sequence) =>
      sequence === "\\\\" || sequence === '\\"' || sequence === "\\/" ? sequence : " "
    )
    .replace(WHITESPACE_RUN, " ")
    .trim();

// A side of the needle that ends in punctuation or a symbol is a boundary by itself ("+48 601 234 567").
const containsAsToken = (haystack: string, needle: string): boolean => {
  const first = needle[0];
  const last = needle[needle.length - 1];
  if (first === undefined || last === undefined) return false;
  const guardBefore = TOKEN_CHARACTER.test(first);
  const guardAfter = TOKEN_CHARACTER.test(last);
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    const before = haystack[from - 1];
    const after = haystack[from + needle.length];
    const flankedBefore = guardBefore && before !== undefined && TOKEN_CHARACTER.test(before);
    const flankedAfter = guardAfter && after !== undefined && TOKEN_CHARACTER.test(after);
    if (!flankedBefore && !flankedAfter) return true;
    from = haystack.indexOf(needle, from + 1);
  }
  return false;
};

export type LeakSecret = {
  label: string;
  value: string;
  // "token": the value leaked only when it stands as whole words, whatever its length. For values made of
  // ordinary words (a participant name), which otherwise hit fixed report text such as "meet.google.com".
  // Without it a value of six characters or more is found anywhere, and a shorter one as a whole token.
  match?: "token";
};

// Returns the labels of the secrets present in the serialised report, never their values.
export const findLeaks = (json: string, secrets: LeakSecret[]): string[] => {
  const haystack = comparable(json);
  let tokenHaystack: string | null = null;
  const leaked: string[] = [];
  for (const secret of secrets) {
    const value = secret.value.trim();
    if (value.length < MIN_SECRET_LENGTH) continue;
    // The file holds JSON, where quotes, backslashes and control characters of a value are escaped.
    const forms = new Set([comparable(value), comparable(JSON.stringify(value).slice(1, -1))]);
    let found: boolean;
    if (secret.match === "token") {
      tokenHaystack ??= tokenComparable(haystack);
      const within = tokenHaystack;
      found = [...forms].map(tokenComparable).some((form) => containsAsToken(within, form));
    } else {
      found = [...forms].some((form) =>
        form.length >= MIN_SECRET_LENGTH_FOR_SUBSTRING_MATCH
          ? haystack.includes(form)
          : containsAsToken(haystack, form)
      );
    }
    if (found && !leaked.includes(secret.label)) leaked.push(secret.label);
  }
  return leaked;
};
