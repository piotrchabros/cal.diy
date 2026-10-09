import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";

// The locale is fixed so the count does not follow the host's default locale: the web process and
// the task worker must agree (script dictionaries are chosen by script, not locale). The instance is
// built once because construction is costly.
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

// Segmentation, not whitespace splitting, so Chinese, Japanese and Thai are not undercounted.
export function countTranscriptWords(passages: readonly Pick<NotetakerPassageRecord, "text">[]): number {
  let total = 0;
  for (const passage of passages) {
    total += Array.from(wordSegmenter.segment(passage.text)).filter((segment) => segment.isWordLike).length;
  }
  return total;
}
