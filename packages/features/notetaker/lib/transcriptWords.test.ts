import { describe, expect, it } from "vitest";
import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";
import { countTranscriptWords } from "./transcriptWords";

const passages = (...texts: string[]): { text: string }[] => texts.map((text) => ({ text }));

describe("countTranscriptWords", () => {
  it("returns 0 for no passages", () => {
    expect(countTranscriptWords([])).toBe(0);
  });

  it("returns 0 for empty and whitespace-only passages", () => {
    expect(countTranscriptWords(passages("", "  \t\n "))).toBe(0);
  });

  it("counts space-separated words", () => {
    expect(countTranscriptWords(passages("Let us review the roadmap"))).toBe(5);
  });

  it("ignores repeated and mixed whitespace", () => {
    expect(countTranscriptWords(passages("  one   two\tthree\nfour\r\n five  "))).toBe(5);
  });

  it("does not count punctuation attached to words", () => {
    expect(countTranscriptWords(passages("Hello, world! How are you?"))).toBe(5);
  });

  it("does not count punctuation alone as a word", () => {
    expect(countTranscriptWords(passages("... -- ?! —"))).toBe(0);
  });

  it("keeps contractions as one word", () => {
    expect(countTranscriptWords(passages("We don't agree"))).toBe(3);
  });

  it("counts hyphenated compounds per part", () => {
    expect(countTranscriptWords(passages("state-of-the-art e-mail"))).toBe(6);
  });

  it("counts numbers as words", () => {
    expect(countTranscriptWords(passages("We shipped 3 releases in 2026"))).toBe(6);
    expect(countTranscriptWords(passages("Revenue grew 3.5 percent"))).toBe(4);
  });

  it("does not count emoji", () => {
    expect(countTranscriptWords(passages("great 👍 work"))).toBe(2);
  });

  it("counts Cyrillic words", () => {
    expect(countTranscriptWords(passages("Привет всем коллегам"))).toBe(3);
  });

  // Expected values are pinned to the ICU dictionary segmentation measured on Node 22.22.3 (ICU 78.2).
  it("does not undercount Japanese", () => {
    expect(countTranscriptWords(passages("来週までに資料を送ります。"))).toBe(7);
  });

  it("does not undercount Thai", () => {
    expect(countTranscriptWords(passages("ขอบคุณทุกคนที่เข้าร่วมประชุม"))).toBe(7);
  });

  it("does not undercount Chinese", () => {
    expect(countTranscriptWords(passages("我们今天讨论项目进度。"))).toBe(5);
  });

  it("sums across passages", () => {
    expect(
      countTranscriptWords(
        passages("Let us review the roadmap", "来週までに資料を送ります。", "ขอบคุณทุกคนที่เข้าร่วมประชุม")
      )
    ).toBe(19);
  });

  it("accepts full passage records", () => {
    const record: NotetakerPassageRecord = {
      index: 0,
      speakerKey: "s1",
      speakerName: null,
      unknownSpeakerNumber: 1,
      startMs: 0,
      endMs: 1000,
      text: "one two three",
      language: "en",
    };
    expect(countTranscriptWords([record])).toBe(3);
  });
});
