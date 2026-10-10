import {
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type {
  JSONOutputFormat,
  Message,
  MessageStreamParams,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { notetakerSummaryContentSchema } from "@calcom/lib/dto/NotetakerSummaryDto";
import { buildSpeakerRoster, getSpeakerLabel } from "../lib/speakerLabel";
import type {
  INotetakerSummaryGenerator,
  NotetakerSummaryFailureCode,
  NotetakerSummaryGeneratorInput,
  NotetakerSummaryResult,
} from "./INotetakerSummaryGenerator";

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatTimestamp(startMs: number): string {
  const totalSeconds = Math.floor(startMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours === 0) return `${minutes}:${pad(seconds)}`;
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

function mapError(error: unknown): { failureCode: NotetakerSummaryFailureCode; retryable: boolean } {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return { failureCode: "AUTHENTICATION_FAILED", retryable: false };
  }
  if (error instanceof RateLimitError) {
    return { failureCode: "RATE_LIMITED", retryable: true };
  }
  if (
    error instanceof BadRequestError ||
    error instanceof NotFoundError ||
    error instanceof UnprocessableEntityError
  ) {
    return { failureCode: "INVALID_REQUEST", retryable: false };
  }
  if (error instanceof APIError) {
    return { failureCode: "PROVIDER_ERROR", retryable: true };
  }
  return { failureCode: "UNEXPECTED_ERROR", retryable: true };
}

export type AnthropicMessagesClient = {
  messages: { stream(params: MessageStreamParams): { finalMessage(): Promise<Message> } };
};

export interface IAnthropicSummaryGeneratorDeps {
  client: AnthropicMessagesClient;
  model: string;
  logger: ISimpleLogger;
}

export const NOTETAKER_SUMMARY_MAX_OUTPUT_TOKENS = 8192;

// Hand-written because the SDK's zod helper needs a zod 4 schema and the DTO schema is zod 3.
export const NOTETAKER_SUMMARY_OUTPUT_FORMAT: JSONOutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["language", "overview", "keyPoints", "decisions", "actionItems"],
    properties: {
      language: { type: "string" },
      overview: { type: "string" },
      keyPoints: { type: "array", items: { type: "string" } },
      decisions: { type: "array", items: { type: "string" } },
      actionItems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "owner"],
          properties: {
            text: { type: "string" },
            owner: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
    },
  },
};

export function buildSummaryPrompt(input: NotetakerSummaryGeneratorInput): { system: string; user: string } {
  const sentences = [
    "You summarise meeting transcripts for the meeting's host.",
    "Write every field in the predominant spoken language of the transcript.",
  ];
  if (input.languageHint !== null) {
    sentences.push(
      `The transcript's detected language is ${input.languageHint}; use it unless the transcript is clearly in another language.`
    );
  }
  sentences.push(
    "Give an action item an owner only when the transcript states who is responsible; otherwise set owner to null.",
    "Do not invent facts: include only points, decisions and action items the transcript supports, and leave a list empty when there is nothing to report.",
    "Respond only with JSON matching the required schema."
  );

  const lines = input.passages.map((passage) => {
    return `[${formatTimestamp(passage.startMs)}] ${getSpeakerLabel(passage)}: ${passage.text}`;
  });
  const roster = buildSpeakerRoster(input.passages).map((names) => `- ${names}`);

  return {
    system: sentences.join(" "),
    user: [
      "Speakers (one line per person; several names on one line are the same person):",
      ...roster,
      "",
      `Transcript (${input.passages.length} passages):`,
      ...lines,
    ].join("\n"),
  };
}

export class AnthropicSummaryGenerator implements INotetakerSummaryGenerator {
  constructor(private readonly deps: IAnthropicSummaryGeneratorDeps) {}

  async generate(input: NotetakerSummaryGeneratorInput): Promise<NotetakerSummaryResult> {
    const passageCount = input.passages.length;

    const fail = (
      failureCode: NotetakerSummaryFailureCode,
      retryable: boolean,
      extra: Record<string, unknown> = {}
    ): NotetakerSummaryResult => {
      this.deps.logger.warn("Notetaker summary generation failed", { failureCode, passageCount, ...extra });
      return { ok: false, failureCode, retryable };
    };

    try {
      const { system, user } = buildSummaryPrompt(input);
      const stream = this.deps.client.messages.stream({
        model: this.deps.model,
        max_tokens: NOTETAKER_SUMMARY_MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: NOTETAKER_SUMMARY_OUTPUT_FORMAT },
      });
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        return fail("REFUSED", false, { category: message.stop_details?.category ?? null });
      }
      if (message.stop_reason === "max_tokens") return fail("OUTPUT_TRUNCATED", false);
      if (message.stop_reason === "model_context_window_exceeded") return fail("CONTEXT_TOO_LONG", false);

      let text = "";
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return fail("INVALID_OUTPUT", true);
      }
      const parsed = notetakerSummaryContentSchema.safeParse(json);
      if (!parsed.success) return fail("INVALID_OUTPUT", true);

      return { ok: true, content: parsed.data, model: message.model };
    } catch (error) {
      const { failureCode, retryable } = mapError(error);
      return fail(failureCode, retryable, {
        status: error instanceof APIError ? error.status : undefined,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorType: error instanceof APIError ? error.type : null,
      });
    }
  }
}
