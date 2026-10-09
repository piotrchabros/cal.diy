import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerSummaryRecord } from "../repositories/interfaces/INotetakerSummaryRepository";

// The choice service and the summary service share this mapping so the DTO cannot drift,
// and internal fields (attempts, failure code, model) stay server-side.
export function toNotetakerSummaryDto(summary: NotetakerSummaryRecord): NotetakerSummaryDto {
  return {
    status: summary.status,
    language: summary.language,
    overview: summary.overview,
    keyPoints: summary.keyPoints,
    decisions: summary.decisions,
    actionItems: summary.actionItems.map((item) => ({ text: item.text, owner: item.owner })),
    generatedAt: summary.generatedAt ? summary.generatedAt.toISOString() : null,
  };
}
