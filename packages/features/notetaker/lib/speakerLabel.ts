import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";

export const DEFAULT_UNKNOWN_SPEAKER_LABEL = (number: number): string => `Unknown speaker ${number}`;

export function getSpeakerLabel(
  passage: { speakerName: string | null; unknownSpeakerNumber: number | null },
  unknownSpeaker: (number: number) => string = DEFAULT_UNKNOWN_SPEAKER_LABEL
): string {
  return passage.speakerName ?? unknownSpeaker(passage.unknownSpeakerNumber ?? 0);
}

/** One line per distinct speakerKey, in order of first appearance, listing every label that key used. */
export function buildSpeakerRoster(passages: readonly NotetakerPassageRecord[]): string[] {
  const labelsByKey = new Map<string, string[]>();
  for (const passage of passages) {
    const label = getSpeakerLabel(passage);
    const labels = labelsByKey.get(passage.speakerKey);
    if (labels === undefined) {
      labelsByKey.set(passage.speakerKey, [label]);
    } else if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  return Array.from(labelsByKey.values()).map((labels) => labels.join(", "));
}
