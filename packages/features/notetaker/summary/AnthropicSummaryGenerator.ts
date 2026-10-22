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
import type { NotetakerSummaryContent } from "@calcom/lib/dto/NotetakerSummaryDto";
import { z } from "zod";
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

// Leaves room for the topic cap with several detail bullets each in long meetings.
export const NOTETAKER_SUMMARY_MAX_OUTPUT_TOKENS = 16000;

export const MAX_KEY_FINDINGS = 15;
export const MAX_NEXT_STEP_GROUPS = 20;
export const MAX_ITEMS_PER_GROUP = 15;
export const MAX_TOPICS = 30;
export const MAX_TOPIC_DETAILS = 8;

const TOPIC_CATEGORIES = ["PROBLEM", "UPDATE", "DECISION"] as const;

const stringArraySchema = { type: "array", items: { type: "string" } };

// Hand-written because the SDK's zod helper needs a zod 4 schema and the DTO schema is zod 3.
export const NOTETAKER_SUMMARY_OUTPUT_FORMAT: JSONOutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["language", "overview", "keyFindings", "nextSteps", "topics"],
    properties: {
      language: { type: "string" },
      overview: { type: "string" },
      keyFindings: stringArraySchema,
      nextSteps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["owner", "items"],
          properties: {
            owner: { anyOf: [{ type: "string" }, { type: "null" }] },
            items: stringArraySchema,
          },
        },
      },
      topics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "category", "details"],
          properties: {
            title: { type: "string" },
            category: { anyOf: [{ type: "string", enum: [...TOPIC_CATEGORIES] }, { type: "null" }] },
            details: stringArraySchema,
          },
        },
      },
    },
  },
};

const summaryOutputSchema = z.object({
  language: z.string(),
  overview: z.string(),
  keyFindings: z.array(z.string()),
  nextSteps: z.array(z.object({ owner: z.string().nullable(), items: z.array(z.string()) })),
  topics: z.array(
    z.object({
      title: z.string(),
      category: z.enum(TOPIC_CATEGORIES).nullable(),
      details: z.array(z.string()),
    })
  ),
});

export type NotetakerSummaryOutput = z.infer<typeof summaryOutputSchema>;

function cleanList(values: string[], max: number): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, max);
}

/** Over-long lists are sliced rather than rejected, so one verbose meeting never fails its summary. */
export function toSummaryContent(output: NotetakerSummaryOutput): NotetakerSummaryContent {
  const actionItems: NotetakerSummaryContent["actionItems"] = [];
  for (const group of output.nextSteps.slice(0, MAX_NEXT_STEP_GROUPS)) {
    const owner = group.owner?.trim() || null;
    for (const text of cleanList(group.items, MAX_ITEMS_PER_GROUP)) {
      actionItems.push({ text, owner });
    }
  }

  const topics: NotetakerSummaryContent["topics"] = [];
  for (const topic of output.topics) {
    if (topics.length >= MAX_TOPICS) break;
    const title = topic.title.trim();
    if (title.length === 0) continue;
    topics.push({ title, category: topic.category, details: cleanList(topic.details, MAX_TOPIC_DETAILS) });
  }

  return {
    language: output.language.trim(),
    overview: output.overview.trim(),
    keyPoints: cleanList(output.keyFindings, MAX_KEY_FINDINGS),
    actionItems,
    topics,
  };
}

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
    "overview: 3-6 sentences covering the meeting's purpose, its main outcomes and its overall tone.",
    "keyFindings: the most important conclusions, findings and agreements, one sentence each, at most 15.",
    "nextSteps: group the action items by the person or team responsible.",
    "Write each owner exactly as the person is named in the speaker list or as the team is named in the transcript.",
    "Give an action item an owner only when the transcript states who is responsible; put every item with no stated owner in a single group and set owner to null for it.",
    "Start each item with a verb and include any deadline the transcript states.",
    "topics: every substantive topic discussed, in chronological order, one entry per distinct topic (typically 5-20 for an hour-long meeting, at most 30).",
    'title: short and specific, naming the people or organisations involved (for example "Lead: <name> (<org>) - <issue>").',
    "details: 2-6 bullets covering the context, the proposals, any options with figures and prices exactly as stated, and the agreements or next actions on that topic.",
    "category: choose from what was concluded about the topic.",
    "DECISION when the participants reached a decision or agreement about it, even if a problem was also raised.",
    "PROBLEM when it centred on an unresolved issue, blocker or risk.",
    "UPDATE when it was mainly a status report or new information with nothing decided.",
    "null when none of these clearly fits.",
    "Do not invent facts: include only findings, topics, details and action items the transcript supports, and leave a list empty when there is nothing to report.",
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
      const parsed = summaryOutputSchema.safeParse(json);
      if (!parsed.success) return fail("INVALID_OUTPUT", true);

      return { ok: true, content: toSummaryContent(parsed.data), model: message.model };
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
