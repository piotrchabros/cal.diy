// @vitest-environment node
import { notetakerBotPassageSchema } from "@calcom/lib/notetaker/botContract";
import { describe, expect, it } from "vitest";
import type { ISpeakerAttributor, SpeakerAttribution } from "../speakers/SpeakerAttribution";
import { MAX_PASSAGE_DURATION_MS, MAX_PASSAGE_TEXT_LENGTH, PassageBuilder } from "./PassageBuilder";

type Utterance = Parameters<PassageBuilder["add"]>[0];
type AttributionRange = Parameters<ISpeakerAttributor["attribute"]>[0];

const ADA: SpeakerAttribution = {
  speakerKey: "participant:p-ada",
  speakerName: "Ada",
  unknownSpeakerNumber: null,
};
const UNKNOWN_1: SpeakerAttribution = {
  speakerKey: "unknown:1",
  speakerName: null,
  unknownSpeakerNumber: 1,
};

class RecordingAttributor implements ISpeakerAttributor {
  readonly calls: AttributionRange[] = [];

  constructor(private readonly resolve: (range: AttributionRange) => SpeakerAttribution = () => ADA) {}

  recordSpeaker(): void {
    return;
  }

  recordParticipants(): void {
    return;
  }

  recordSourceActivity(): void {
    return;
  }

  recordSourceIdentity(): void {
    return;
  }

  attribute(utterance: AttributionRange): SpeakerAttribution {
    this.calls.push({ ...utterance });
    return this.resolve(utterance);
  }

  resolutions(): [] {
    return [];
  }

  namesAvailable(): boolean {
    return false;
  }
}

function utterance(overrides: Partial<Utterance>): Utterance {
  return { startMs: 0, endMs: 1000, text: "hello", language: "en", diarizationLabel: "S1", ...overrides };
}

function words(n: number): string {
  return Array.from({ length: n }, () => "aaaa").join(" ");
}

function setup(resolve?: (range: AttributionRange) => SpeakerAttribution): {
  attributor: RecordingAttributor;
  builder: PassageBuilder;
} {
  const attributor = new RecordingAttributor(resolve);
  return { attributor, builder: new PassageBuilder({ attributor }) };
}

function passage(
  index: number,
  text: string,
  startMs: number,
  endMs: number,
  attribution: SpeakerAttribution = ADA,
  language: string | null = "en"
) {
  return { index, ...attribution, startMs, endMs, text, language };
}

function expectedPieces(pieces: { text: string; startMs: number; endMs: number }[]) {
  return pieces.map((piece, index) => passage(index, piece.text, piece.startMs, piece.endMs));
}

const WORDS_300 = utterance({ startMs: 0, endMs: 30000, text: words(300) });
const LONG_WORD = utterance({ startMs: 1000, endMs: 26000, text: "x".repeat(2500) });
const TEN_WORDS = utterance({
  startMs: 0,
  endMs: 100000,
  text: Array(10).fill("abcd").join(" "),
});
const SURROGATE = utterance({
  startMs: 0,
  endMs: 10110,
  text: `${"a".repeat(999)}😀${"b".repeat(10)}`,
});
const SINGLE_WORD_OVER_CAP = utterance({ startMs: 1000, endMs: 151000, text: "hello" });
const TWO_WORDS_OVER_CAP = utterance({ startMs: 0, endMs: 150000, text: "one two" });

describe("PassageBuilder", () => {
  it("exports the two caps", () => {
    expect(MAX_PASSAGE_DURATION_MS).toBe(60000);
    expect(MAX_PASSAGE_TEXT_LENGTH).toBe(1000);
  });

  it("one short utterance gives one passage", () => {
    const { attributor, builder } = setup();

    const passages = builder.add(
      utterance({ startMs: 1000, endMs: 4000, text: "Hello there", language: "en", diarizationLabel: "S1" })
    );

    expect(passages).toEqual([
      { index: 0, ...ADA, startMs: 1000, endMs: 4000, text: "Hello there", language: "en" },
    ]);
    expect(attributor.calls).toEqual([{ startMs: 1000, endMs: 4000, diarizationLabel: "S1" }]);
    expect(builder.passageCount).toBe(1);
  });

  it("carries an unknown speaker", () => {
    const { builder } = setup(() => UNKNOWN_1);

    const passages = builder.add(utterance({ text: "hi" }));

    expect(passages).toEqual([passage(0, "hi", 0, 1000, UNKNOWN_1)]);
    expect(passages[0]?.speakerKey).toBe("unknown:1");
    expect(passages[0]?.speakerName).toBeNull();
    expect(passages[0]?.unknownSpeakerNumber).toBe(1);
  });

  it("carries the language, null included", () => {
    const nullLanguage = setup().builder.add(utterance({ language: null }));
    expect(nullLanguage).toEqual([passage(0, "hello", 0, 1000, ADA, null)]);

    const polish = setup().builder.add({ ...WORDS_300, language: "pl" });
    expect(polish).toHaveLength(2);
    expect(polish.map((p) => p.language)).toEqual(["pl", "pl"]);
  });

  it("trims the text", () => {
    const { builder } = setup();

    expect(builder.add(utterance({ text: "  Hello there \n" }))).toEqual([
      passage(0, "Hello there", 0, 1000),
    ]);
  });

  it("keeps inner whitespace", () => {
    const { builder } = setup();

    expect(builder.add(utterance({ text: "a  b\nc" }))).toEqual([passage(0, "a  b\nc", 0, 1000)]);
  });

  it("empty text gives no passage", () => {
    const { attributor, builder } = setup();

    expect(builder.add(utterance({ text: "" }))).toEqual([]);
    expect(builder.add(utterance({ text: " \n\t " }))).toEqual([]);
    expect(attributor.calls).toEqual([]);
    expect(builder.passageCount).toBe(0);
    expect(builder.add(utterance({ text: "real" }))).toEqual([passage(0, "real", 0, 1000)]);
  });

  it("index counts across the session", () => {
    const { builder } = setup();

    const first = builder.add(utterance({ text: "one" }));
    const second = builder.add(WORDS_300);
    const third = builder.add(utterance({ text: "" }));
    const fourth = builder.add(utterance({ text: "two" }));

    expect(first.map((p) => p.index)).toEqual([0]);
    expect(second.map((p) => p.index)).toEqual([1, 2]);
    expect(third).toEqual([]);
    expect(fourth.map((p) => p.index)).toEqual([3]);
    expect(builder.passageCount).toBe(4);
  });

  it("utterances are never merged", () => {
    const { builder } = setup();

    const first = builder.add(utterance({ startMs: 0, endMs: 1000, text: "a" }));
    const second = builder.add(utterance({ startMs: 1000, endMs: 2000, text: "b" }));

    expect(first).toEqual([passage(0, "a", 0, 1000)]);
    expect(second).toEqual([passage(1, "b", 1000, 2000)]);
  });

  it("exactly 1,000 characters is one passage", () => {
    const { builder } = setup();
    const text = "a".repeat(1000);

    const passages = builder.add(utterance({ startMs: 0, endMs: 10000, text }));

    expect(passages).toEqual([passage(0, text, 0, 10000)]);
    expect(passages[0]?.text).toHaveLength(1000);
  });

  it("splits at whitespace on length", () => {
    const { builder } = setup();

    expect(builder.add(WORDS_300)).toEqual(
      expectedPieces([
        { text: words(200), startMs: 0, endMs: 20013 },
        { text: words(100), startMs: 20013, endMs: 30000 },
      ])
    );
  });

  it("cuts a single over-long word hard", () => {
    const { builder } = setup();

    expect(builder.add(LONG_WORD)).toEqual(
      expectedPieces([
        { text: "x".repeat(1000), startMs: 1000, endMs: 11000 },
        { text: "x".repeat(1000), startMs: 11000, endMs: 21000 },
        { text: "x".repeat(500), startMs: 21000, endMs: 26000 },
      ])
    );
  });

  it("the rest of a cut word joins the words after it", () => {
    const { builder } = setup();

    const passages = builder.add(utterance({ startMs: 0, endMs: 12050, text: `${"x".repeat(1200)} tail` }));

    expect(passages).toEqual(
      expectedPieces([
        { text: "x".repeat(1000), startMs: 0, endMs: 10000 },
        { text: `${"x".repeat(200)} tail`, startMs: 10000, endMs: 12050 },
      ])
    );
  });

  it("a long word after normal words closes the piece first", () => {
    const { builder } = setup();

    const passages = builder.add(utterance({ startMs: 0, endMs: 15060, text: `intro ${"y".repeat(1500)}` }));

    expect(passages).toEqual(
      expectedPieces([
        { text: "intro", startMs: 0, endMs: 60 },
        { text: "y".repeat(1000), startMs: 60, endMs: 10060 },
        { text: "y".repeat(500), startMs: 10060, endMs: 15060 },
      ])
    );
  });

  it("a hard cut never splits a surrogate pair", () => {
    const { builder } = setup();

    expect(builder.add(SURROGATE)).toEqual(
      expectedPieces([
        { text: "a".repeat(999), startMs: 0, endMs: 9990 },
        { text: `😀${"b".repeat(10)}`, startMs: 9990, endMs: 10110 },
      ])
    );
  });

  it("pieces are trimmed at a multi-character gap", () => {
    const { builder } = setup();

    const passages = builder.add(
      utterance({ startMs: 0, endMs: 10130, text: `${"x".repeat(1000)} \n ${"y".repeat(10)}` })
    );

    expect(passages).toEqual(
      expectedPieces([
        { text: "x".repeat(1000), startMs: 0, endMs: 10030 },
        { text: "y".repeat(10), startMs: 10030, endMs: 10130 },
      ])
    );
  });

  it("splits at whitespace on duration", () => {
    const { builder } = setup();
    const half = "abcd abcd abcd abcd abcd";

    expect(builder.add(TEN_WORDS)).toEqual(
      expectedPieces([
        { text: half, startMs: 0, endMs: 51020 },
        { text: half, startMs: 51020, endMs: 100000 },
      ])
    );
  });

  it("few words over a long time", () => {
    const { builder } = setup();

    const passages = builder.add(utterance({ startMs: 0, endMs: 150000, text: "one two three" }));

    expect(passages).toEqual(
      expectedPieces([
        { text: "one", startMs: 0, endMs: 46154 },
        { text: "two", startMs: 46154, endMs: 92308 },
        { text: "three", startMs: 92308, endMs: 150000 },
      ])
    );
  });

  it("exactly 60 s is one passage, one more ms splits", () => {
    const exact = setup().builder.add(utterance({ startMs: 0, endMs: 60000, text: "one two" }));
    expect(exact).toEqual([passage(0, "one two", 0, 60000)]);

    const over = setup().builder.add(utterance({ startMs: 0, endMs: 60001, text: "one two" }));
    expect(over).toEqual(
      expectedPieces([
        { text: "one", startMs: 0, endMs: 34286 },
        { text: "two", startMs: 34286, endMs: 60001 },
      ])
    );
  });

  it("a single word longer than 60 s is capped, never cut", () => {
    const { attributor, builder } = setup();

    const passages = builder.add(SINGLE_WORD_OVER_CAP);

    expect(passages).toEqual([passage(0, "hello", 1000, 61000)]);
    expect(attributor.calls).toEqual([{ startMs: 1000, endMs: 61000, diarizationLabel: "S1" }]);
  });

  it("words that cannot fit 60 s are capped and leave a gap", () => {
    const { builder } = setup();

    expect(builder.add(TWO_WORDS_OVER_CAP)).toEqual(
      expectedPieces([
        { text: "one", startMs: 0, endMs: 60000 },
        { text: "two", startMs: 85714, endMs: 145714 },
      ])
    );
  });

  it("each piece is attributed on its own range", () => {
    const { attributor, builder } = setup((range) => (range.startMs < 51020 ? ADA : UNKNOWN_1));
    const half = "abcd abcd abcd abcd abcd";

    const passages = builder.add({ ...TEN_WORDS, diarizationLabel: "S3" });

    expect(attributor.calls).toEqual([
      { startMs: 0, endMs: 51020, diarizationLabel: "S3" },
      { startMs: 51020, endMs: 100000, diarizationLabel: "S3" },
    ]);
    expect(passages).toEqual([passage(0, half, 0, 51020, ADA), passage(1, half, 51020, 100000, UNKNOWN_1)]);
  });

  it("pieces are contiguous and ordered", () => {
    const inputs = [WORDS_300, LONG_WORD, TEN_WORDS];

    for (const input of inputs) {
      const passages = setup().builder.add(input);

      expect(passages.length).toBeGreaterThan(1);
      expect(passages[0]?.startMs).toBe(input.startMs);
      expect(passages[passages.length - 1]?.endMs).toBe(input.endMs);
      for (const [i, p] of passages.entries()) {
        expect(p.endMs).toBeGreaterThanOrEqual(p.startMs);
        const next = passages[i + 1];
        if (next) expect(p.endMs).toBe(next.startMs);
      }
    }
  });

  it("zero-length utterance", () => {
    const { builder } = setup();

    const passages = builder.add(utterance({ startMs: 5000, endMs: 5000, text: "x".repeat(1500) }));

    expect(passages).toEqual(
      expectedPieces([
        { text: "x".repeat(1000), startMs: 5000, endMs: 5000 },
        { text: "x".repeat(500), startMs: 5000, endMs: 5000 },
      ])
    );
  });

  it("reversed times collapse to the start", () => {
    const { builder } = setup();

    expect(builder.add(utterance({ startMs: 5000, endMs: 4000, text: "hi" }))).toEqual([
      passage(0, "hi", 5000, 5000),
    ]);
  });

  it("non-integer, negative and non-finite times", () => {
    const times: { startMs: number; endMs: number; expectedStart: number; expectedEnd: number }[] = [
      { startMs: 1000.4, endMs: 2999.6, expectedStart: 1000, expectedEnd: 3000 },
      { startMs: -5, endMs: 500, expectedStart: 0, expectedEnd: 500 },
      { startMs: Number.NaN, endMs: 500, expectedStart: 0, expectedEnd: 500 },
      { startMs: 1000, endMs: Number.POSITIVE_INFINITY, expectedStart: 1000, expectedEnd: 1000 },
    ];

    for (const time of times) {
      const { builder } = setup();
      const passages = builder.add(utterance({ startMs: time.startMs, endMs: time.endMs, text: "hi" }));
      expect(passages).toEqual([passage(0, "hi", time.expectedStart, time.expectedEnd)]);
    }
  });

  it("every passage satisfies the wire schema and both caps", () => {
    const inputs = [WORDS_300, LONG_WORD, SURROGATE, SINGLE_WORD_OVER_CAP, TWO_WORDS_OVER_CAP];

    for (const input of inputs) {
      const passages = setup().builder.add(input);

      expect(passages.length).toBeGreaterThan(0);
      for (const p of passages) {
        expect(notetakerBotPassageSchema.safeParse(p).success).toBe(true);
        expect(p.text.length).toBeLessThanOrEqual(MAX_PASSAGE_TEXT_LENGTH);
        expect(p.endMs - p.startMs).toBeLessThanOrEqual(MAX_PASSAGE_DURATION_MS);
      }
    }
  });
});
