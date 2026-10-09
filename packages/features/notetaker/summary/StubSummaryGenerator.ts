import type { NotetakerSummaryContent } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";
import type {
  INotetakerSummaryGenerator,
  NotetakerSummaryGeneratorInput,
  NotetakerSummaryResult,
} from "./INotetakerSummaryGenerator";

const MAX_ITEMS = 3;
const KEY_POINT_PASSAGE_WINDOW = 10;
const OVERVIEW_MAX_LENGTH = 300;
const KEY_POINT_MAX_LENGTH = 120;

function getSpeakerLabel(passage: NotetakerPassageRecord): string {
  return passage.speakerName ?? `Speaker ${passage.unknownSpeakerNumber ?? "?"}`;
}

export const STUB_SUMMARY_MODEL = "stub";

/** Deterministic keyword-based summary for local development and tests, so no provider key is needed. */
export class StubSummaryGenerator implements INotetakerSummaryGenerator {
  async generate(input: NotetakerSummaryGeneratorInput): Promise<NotetakerSummaryResult> {
    const { passages } = input;

    const firstPassageLanguage = passages.find((passage) => passage.language !== null)?.language;
    const language = input.languageHint ?? firstPassageLanguage ?? "en";

    const overview = passages
      .slice(0, MAX_ITEMS)
      .map((passage) => passage.text)
      .join(" ")
      .slice(0, OVERVIEW_MAX_LENGTH);

    const keyPoints: string[] = [];
    const seenLabels: string[] = [];
    for (const passage of passages.slice(0, KEY_POINT_PASSAGE_WINDOW)) {
      if (keyPoints.length >= MAX_ITEMS) break;
      const label = getSpeakerLabel(passage);
      if (seenLabels.includes(label)) continue;
      seenLabels.push(label);
      keyPoints.push(`${label}: ${passage.text}`.slice(0, KEY_POINT_MAX_LENGTH));
    }

    const decisions: string[] = [];
    const actionItems: NotetakerSummaryContent["actionItems"] = [];
    for (const passage of passages) {
      const lower = passage.text.toLowerCase();
      if (decisions.length < MAX_ITEMS && (lower.includes("decid") || lower.includes("agree"))) {
        decisions.push(passage.text);
      }
      if (actionItems.length < MAX_ITEMS && (lower.includes(" will ") || lower.includes("action"))) {
        actionItems.push({ text: passage.text, owner: passage.speakerName });
      }
    }

    const content: NotetakerSummaryContent = { language, overview, keyPoints, decisions, actionItems };
    return { ok: true, content, model: STUB_SUMMARY_MODEL };
  }
}
