import type { NotetakerBotPassage } from "@calcom/lib/notetaker/botContract";
import type { ISpeakerAttributor } from "../speakers/SpeakerAttribution";
import type { SttUtterance } from "../stt/SpeechToTextProvider";

const MAX_PASSAGE_DURATION_MS = 60000;
const MAX_PASSAGE_TEXT_LENGTH = 1000;

type Word = { start: number; end: number; next: number };
type Span = { a: number; b: number };

function toMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function findWords(text: string): Word[] {
  const runs: { start: number; end: number }[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    runs.push({ start, end: start + match[0].length });
  }
  return runs.map((run, i) => ({ ...run, next: runs[i + 1]?.start ?? text.length }));
}

// The wire schema counts UTF-16 units, so a cut between the halves of a pair would leave
// two invalid fragments.
function cutOffset(text: string, wordStart: number): number {
  const cut = wordStart + MAX_PASSAGE_TEXT_LENGTH;
  const before = text.charCodeAt(cut - 1);
  const after = text.charCodeAt(cut);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  if (splitsPair) return cut - 1;
  return cut;
}

function splitIntoSpans(text: string, timeAt: (offset: number) => number): Span[] {
  const spans: Span[] = [];
  const pending = findWords(text).reverse();
  let pieceStart: number | null = null;

  for (let word = pending.pop(); word !== undefined; word = pending.pop()) {
    if (pieceStart === null) {
      if (word.end - word.start > MAX_PASSAGE_TEXT_LENGTH) {
        const cut = cutOffset(text, word.start);
        spans.push({ a: word.start, b: cut });
        pending.push({ start: cut, end: word.end, next: word.next });
      } else {
        pieceStart = word.start;
      }
      continue;
    }
    const fits =
      word.end - pieceStart <= MAX_PASSAGE_TEXT_LENGTH &&
      timeAt(word.next) - timeAt(pieceStart) <= MAX_PASSAGE_DURATION_MS;
    if (!fits) {
      spans.push({ a: pieceStart, b: word.start });
      pieceStart = null;
      pending.push(word);
    }
  }
  if (pieceStart !== null) spans.push({ a: pieceStart, b: text.length });
  return spans;
}

class PassageBuilder {
  private readonly attributor: ISpeakerAttributor;
  private count = 0;

  constructor(deps: { attributor: ISpeakerAttributor }) {
    this.attributor = deps.attributor;
  }

  get passageCount(): number {
    return this.count;
  }

  add(utterance: SttUtterance): NotetakerBotPassage[] {
    const startMs = toMs(utterance.startMs);
    const durationMs = Math.max(startMs, toMs(utterance.endMs)) - startMs;
    const text = utterance.text.trim();
    if (text === "") return [];

    const timeAt = (offset: number): number => startMs + Math.round((durationMs * offset) / text.length);
    const passages: NotetakerBotPassage[] = [];

    for (const span of splitIntoSpans(text, timeAt)) {
      const pieceStartMs = timeAt(span.a);
      // A piece longer than the cap is one word or one hard-cut chunk; cutting it by time
      // would put fragments in the transcript, so it is clamped and a gap follows.
      const pieceEndMs = Math.min(timeAt(span.b), pieceStartMs + MAX_PASSAGE_DURATION_MS);
      const attribution = this.attributor.attribute({
        startMs: pieceStartMs,
        endMs: pieceEndMs,
        diarizationLabel: utterance.diarizationLabel,
      });
      passages.push({
        index: this.count++,
        speakerKey: attribution.speakerKey,
        speakerName: attribution.speakerName,
        unknownSpeakerNumber: attribution.unknownSpeakerNumber,
        startMs: pieceStartMs,
        endMs: pieceEndMs,
        text: text.slice(span.a, span.b).trim(),
        language: utterance.language,
      });
    }
    return passages;
  }
}

export { MAX_PASSAGE_DURATION_MS, MAX_PASSAGE_TEXT_LENGTH, PassageBuilder };
