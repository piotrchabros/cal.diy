import type { INotetakerSummaryGenerator, NotetakerSummaryResult } from "./INotetakerSummaryGenerator";

// Production without an API key must fail visibly instead of serving stub text.
export class DisabledSummaryGenerator implements INotetakerSummaryGenerator {
  async generate(): Promise<NotetakerSummaryResult> {
    return { ok: false, failureCode: "GENERATOR_DISABLED", retryable: false };
  }
}
