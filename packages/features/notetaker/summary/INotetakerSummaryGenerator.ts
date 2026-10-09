import type { NotetakerSummaryContent } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";

export type NotetakerSummaryFailureCode =
  | "REFUSED" // stop_reason "refusal"
  | "INVALID_OUTPUT" // text is not JSON, or fails notetakerSummaryContentSchema
  | "OUTPUT_TRUNCATED" // stop_reason "max_tokens"
  | "CONTEXT_TOO_LONG" // stop_reason "model_context_window_exceeded"
  | "AUTHENTICATION_FAILED" // 401 / 403
  | "INVALID_REQUEST" // 400 / 404 / 422 (for example an unknown NOTETAKER_SUMMARY_MODEL)
  | "RATE_LIMITED" // 429 after the SDK's own retries
  | "PROVIDER_ERROR" // 5xx, connection or timeout
  | "GENERATOR_DISABLED" // DisabledSummaryGenerator (production without a key)
  | "ENQUEUE_FAILED" // written by the service when the task could not be queued
  | "UNEXPECTED_ERROR"; // a generator threw; mapped by the service

export type NotetakerSummaryGeneratorInput = {
  passages: readonly NotetakerPassageRecord[]; // whole transcript, ordered by index
  languageHint: string | null;
};

export type NotetakerSummaryResult =
  | { ok: true; content: NotetakerSummaryContent; model: string }
  | { ok: false; failureCode: NotetakerSummaryFailureCode; retryable: boolean };

export interface INotetakerSummaryGenerator {
  /** Never rejects: every failure is a result. Never logs or returns passage text. */
  generate(input: NotetakerSummaryGeneratorInput): Promise<NotetakerSummaryResult>;
}
