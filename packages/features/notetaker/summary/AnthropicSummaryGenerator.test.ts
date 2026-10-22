/** @vitest-environment node */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type { Message, MessageStreamParams } from "@anthropic-ai/sdk/resources/messages/messages";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { notetakerSummaryContentSchema } from "@calcom/lib/dto/NotetakerSummaryDto";
import { describe, expect, it, vi } from "vitest";
import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";
import {
  AnthropicSummaryGenerator,
  buildSummaryPrompt,
  MAX_ITEMS_PER_GROUP,
  MAX_KEY_FINDINGS,
  MAX_NEXT_STEP_GROUPS,
  MAX_TOPIC_DETAILS,
  MAX_TOPICS,
  NOTETAKER_SUMMARY_MAX_OUTPUT_TOKENS,
  NOTETAKER_SUMMARY_OUTPUT_FORMAT,
  type NotetakerSummaryOutput,
  toSummaryContent,
} from "./AnthropicSummaryGenerator";

const SECRET = "zxqvsecretpassagetoken";

const VALID_OUTPUT: NotetakerSummaryOutput = {
  language: "en",
  overview: "The team reviewed the launch plan.",
  keyFindings: ["Launch is on track"],
  nextSteps: [
    { owner: null, items: ["Book a room"] },
    { owner: "Sam", items: ["Send the notes", "Call the venue by Friday"] },
  ],
  topics: [
    { title: "Launch date", category: "DECISION", details: ["Ship on Friday", "Marketing is ready"] },
    { title: "Small talk", category: null, details: ["Weather"] },
  ],
};

const VALID_CONTENT = {
  language: "en",
  overview: "The team reviewed the launch plan.",
  keyPoints: ["Launch is on track"],
  actionItems: [
    { text: "Book a room", owner: null },
    { text: "Send the notes", owner: "Sam" },
    { text: "Call the venue by Friday", owner: "Sam" },
  ],
  topics: [
    { title: "Launch date", category: "DECISION", details: ["Ship on Friday", "Marketing is ready"] },
    { title: "Small talk", category: null, details: ["Weather"] },
  ],
};

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
}

function buildPassage(overrides: Partial<NotetakerPassageRecord> = {}): NotetakerPassageRecord {
  return {
    index: 0,
    speakerKey: "speaker-1",
    speakerName: "Alex",
    unknownSpeakerNumber: null,
    startMs: 0,
    endMs: 1000,
    text: "hello",
    language: "en",
    ...overrides,
  };
}

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test-model",
    container: null,
    diagnostics: null,
    content: [{ type: "text", text: "{}", citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 1,
      output_tokens: 1,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  };
}

function textMessage(text: string, overrides: Partial<Message> = {}): Message {
  return buildMessage({ content: [{ type: "text", text, citations: null }], ...overrides });
}

function createClient(finalMessage: () => Promise<Message>) {
  return { messages: { stream: vi.fn((_params: MessageStreamParams) => ({ finalMessage })) } };
}

function createGenerator(finalMessage: () => Promise<Message>, model = "claude-configured") {
  const client = createClient(finalMessage);
  const logger = createLogger();
  const generator = new AnthropicSummaryGenerator({ client, model, logger });
  return { client, logger, generator };
}

function okMessage() {
  return async () => textMessage(JSON.stringify(VALID_OUTPUT));
}

function getRequest(client: ReturnType<typeof createClient>): MessageStreamParams {
  return client.messages.stream.mock.calls[0][0];
}

function allLogOutput(logger: ReturnType<typeof createLogger>): string {
  return JSON.stringify([
    logger.debug.mock.calls,
    logger.error.mock.calls,
    logger.info.mock.calls,
    logger.warn.mock.calls,
  ]);
}

function requestSystem(client: ReturnType<typeof createClient>): string {
  const { system } = getRequest(client);
  if (typeof system !== "string") throw new Error("Expected a string system prompt");
  return system;
}

function requestUserContent(client: ReturnType<typeof createClient>): string {
  const [message] = getRequest(client).messages;
  if (typeof message.content !== "string") throw new Error("Expected string user content");
  return message.content;
}

describe("AnthropicSummaryGenerator request", () => {
  it("sends the configured model", async () => {
    const first = createGenerator(okMessage(), "claude-opus-5-5");
    const second = createGenerator(okMessage(), "another-model");

    await first.generator.generate({ passages: [buildPassage()], languageHint: null });
    await second.generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(getRequest(first.client).model).toBe("claude-opus-5-5");
    expect(getRequest(second.client).model).toBe("another-model");
  });

  it("sends the max output tokens constant", async () => {
    const { client, generator } = createGenerator(okMessage());

    await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(NOTETAKER_SUMMARY_MAX_OUTPUT_TOKENS).toBe(16000);
    expect(getRequest(client).max_tokens).toBe(NOTETAKER_SUMMARY_MAX_OUTPUT_TOKENS);
  });

  it("sends exactly the expected keys", async () => {
    const { client, generator } = createGenerator(okMessage());

    await generator.generate({ passages: [buildPassage()], languageHint: null });

    const request = getRequest(client);
    expect(Object.keys(request).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "output_config",
      "system",
    ]);
    expect(request).not.toHaveProperty("thinking");
    expect(request).not.toHaveProperty("temperature");
  });

  it("sends one user message containing every passage once", async () => {
    const { client, generator } = createGenerator(okMessage());

    await generator.generate({
      passages: [
        buildPassage({ index: 0, speakerName: "Alex", text: "first passage text" }),
        buildPassage({ index: 1, speakerName: null, unknownSpeakerNumber: 2, text: "second passage text" }),
        buildPassage({ index: 2, speakerName: null, unknownSpeakerNumber: null, text: "third passage text" }),
      ],
      languageHint: null,
    });

    const { messages } = getRequest(client);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const content = requestUserContent(client);
    expect(content).toContain("\nTranscript (3 passages):\n");
    for (const text of ["first passage text", "second passage text", "third passage text"]) {
      expect(content.split(text)).toHaveLength(2);
    }
    expect(content).toContain("Alex: first passage text");
    expect(content).toContain("Unknown speaker 2: second passage text");
    expect(content).toContain("Unknown speaker 0: third passage text");
    expect(content).not.toContain("Speaker 2:");
    expect(content).not.toContain("] Speaker ");
  });

  it("lists the speakers before the transcript, with every name a person used on one line", () => {
    const { user } = buildSummaryPrompt({
      passages: [
        buildPassage({ index: 0, speakerKey: "participant:a", speakerName: "Alex", text: "one" }),
        buildPassage({ index: 1, speakerKey: "participant:a", speakerName: "Alex Example", text: "two" }),
        buildPassage({
          index: 2,
          speakerKey: "unknown:1",
          speakerName: null,
          unknownSpeakerNumber: 1,
          text: "three",
        }),
      ],
      languageHint: null,
    });

    expect(
      user.startsWith(
        "Speakers (one line per person; several names on one line are the same person):\n- Alex, Alex Example\n- Unknown speaker 1\n\nTranscript (3 passages):\n"
      )
    ).toBe(true);
  });

  it("formats timestamps", () => {
    const { user } = buildSummaryPrompt({
      passages: [
        buildPassage({ startMs: 65000, text: "a" }),
        buildPassage({ startMs: 3725000, text: "b" }),
        buildPassage({ startMs: 0, text: "c" }),
      ],
      languageHint: null,
    });

    expect(user).toContain("[1:05] Alex: a");
    expect(user).toContain("[1:02:05] Alex: b");
    expect(user).toContain("[0:00] Alex: c");
  });

  it("states the language, owner and no-invention rules in the system prompt", async () => {
    const { client, generator } = createGenerator(okMessage());

    await generator.generate({ passages: [buildPassage()], languageHint: null });

    const system = requestSystem(client);
    expect(system).toContain("Write every field in the predominant spoken language of the transcript.");
    expect(system).toContain("set owner to null");
    expect(system).toContain("Do not invent facts");
    expect(system).not.toContain("detected language");
  });

  it("states the section and category rules in the system prompt", () => {
    const { system } = buildSummaryPrompt({ passages: [buildPassage()], languageHint: null });

    expect(system).toContain("overview: 3-6 sentences");
    expect(system).toContain("keyFindings:");
    expect(system).toContain("at most 15");
    expect(system).toContain("nextSteps: group the action items by the person or team responsible.");
    expect(system).toContain("exactly as the person is named in the speaker list");
    expect(system).toContain("Start each item with a verb");
    expect(system).toContain("in chronological order");
    expect(system).toContain("at most 30");
    expect(system).toContain("details: 2-6 bullets");
    expect(system).toContain("figures and prices exactly as stated");
    expect(system).toContain("DECISION when the participants reached a decision or agreement");
    expect(system).toContain("even if a problem was also raised");
    expect(system).toContain("PROBLEM when it centred on an unresolved issue, blocker or risk.");
    expect(system).toContain("UPDATE when it was mainly a status report");
    expect(system).toContain("null when none of these clearly fits.");
  });

  it("mentions the language hint only when there is one", () => {
    const withHint = buildSummaryPrompt({ passages: [buildPassage()], languageHint: "pl" });

    expect(withHint.system).toContain("The transcript's detected language is pl;");
  });

  it("requests the structured output format", async () => {
    const { client, generator } = createGenerator(okMessage());

    await generator.generate({ passages: [buildPassage()], languageHint: null });

    const request = getRequest(client);
    expect(request.output_config).toEqual({ format: NOTETAKER_SUMMARY_OUTPUT_FORMAT });
    expect(request.output_config?.format).toBe(NOTETAKER_SUMMARY_OUTPUT_FORMAT);
    expect(request.output_config).not.toHaveProperty("effort");
  });
});

describe("NOTETAKER_SUMMARY_OUTPUT_FORMAT", () => {
  const { schema } = NOTETAKER_SUMMARY_OUTPUT_FORMAT;
  const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

  it("requires every top-level field and forbids others", () => {
    const expectedKeys = ["language", "overview", "keyFindings", "nextSteps", "topics"];

    expect(NOTETAKER_SUMMARY_OUTPUT_FORMAT.type).toBe("json_schema");
    expect(schema).toHaveProperty("required", expectedKeys);
    expect(Object.keys(schema.properties as object)).toEqual(expectedKeys);
    expect(schema).toHaveProperty("additionalProperties", false);
  });

  it("groups next steps under a nullable owner", () => {
    expect(schema).toHaveProperty("properties.nextSteps.items.required", ["owner", "items"]);
    expect(schema).toHaveProperty("properties.nextSteps.items.additionalProperties", false);
    expect(schema).toHaveProperty("properties.nextSteps.items.properties.owner", nullableString);
  });

  it("gives topics a nullable category limited to the three badges", () => {
    expect(schema).toHaveProperty("properties.topics.items.required", ["title", "category", "details"]);
    expect(schema).toHaveProperty("properties.topics.items.additionalProperties", false);
    expect(schema).toHaveProperty("properties.topics.items.properties.category", {
      anyOf: [{ type: "string", enum: ["PROBLEM", "UPDATE", "DECISION"] }, { type: "null" }],
    });
  });

  it("produces content that passes the content schema", () => {
    expect(notetakerSummaryContentSchema.safeParse(toSummaryContent(VALID_OUTPUT)).success).toBe(true);
  });
});

describe("toSummaryContent", () => {
  it("flattens next steps into action items in order, keeping each group's owner", () => {
    const content = toSummaryContent({
      ...VALID_OUTPUT,
      nextSteps: [
        { owner: "Ada", items: ["First", "Second"] },
        { owner: "  Ops team  ", items: ["Third"] },
        { owner: "   ", items: ["Fourth"] },
        { owner: null, items: ["Fifth"] },
      ],
    });

    expect(content.actionItems).toEqual([
      { text: "First", owner: "Ada" },
      { text: "Second", owner: "Ada" },
      { text: "Third", owner: "Ops team" },
      { text: "Fourth", owner: null },
      { text: "Fifth", owner: null },
    ]);
  });

  it("trims strings and drops empty ones", () => {
    const content = toSummaryContent({
      language: " pl ",
      overview: "  Przegląd  ",
      keyFindings: [" Wniosek ", "", "   "],
      nextSteps: [{ owner: "Ada", items: ["  Zadanie ", " "] }],
      topics: [
        { title: "  Temat  ", category: "UPDATE", details: [" Szczegół ", ""] },
        { title: "   ", category: "PROBLEM", details: ["orphan detail"] },
      ],
    });

    expect(content).toEqual({
      language: "pl",
      overview: "Przegląd",
      keyPoints: ["Wniosek"],
      actionItems: [{ text: "Zadanie", owner: "Ada" }],
      topics: [{ title: "Temat", category: "UPDATE", details: ["Szczegół"] }],
    });
  });

  it("keeps a null category", () => {
    const content = toSummaryContent({
      ...VALID_OUTPUT,
      topics: [{ title: "Intro", category: null, details: ["Hello"] }],
    });

    expect(content.topics).toEqual([{ title: "Intro", category: null, details: ["Hello"] }]);
  });

  it("slices over-long lists to their caps instead of rejecting them", () => {
    const strings = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
    const content = toSummaryContent({
      ...VALID_OUTPUT,
      keyFindings: strings(MAX_KEY_FINDINGS + 5, "finding"),
      nextSteps: Array.from({ length: MAX_NEXT_STEP_GROUPS + 3 }, (_, index) => ({
        owner: `Owner ${index}`,
        items: strings(MAX_ITEMS_PER_GROUP + 2, `item ${index}`),
      })),
      topics: Array.from({ length: MAX_TOPICS + 4 }, (_, index) => ({
        title: `Topic ${index}`,
        category: null,
        details: strings(MAX_TOPIC_DETAILS + 3, "detail"),
      })),
    });

    expect(content.keyPoints).toEqual(strings(MAX_KEY_FINDINGS, "finding"));
    expect(content.actionItems).toHaveLength(MAX_NEXT_STEP_GROUPS * MAX_ITEMS_PER_GROUP);
    expect(content.actionItems.at(-1)).toEqual({
      text: `item ${MAX_NEXT_STEP_GROUPS - 1} ${MAX_ITEMS_PER_GROUP - 1}`,
      owner: `Owner ${MAX_NEXT_STEP_GROUPS - 1}`,
    });
    expect(content.topics).toHaveLength(MAX_TOPICS);
    expect(content.topics.at(-1)?.title).toBe(`Topic ${MAX_TOPICS - 1}`);
    expect(content.topics.every((topic) => topic.details.length === MAX_TOPIC_DETAILS)).toBe(true);
  });
});

describe("AnthropicSummaryGenerator results", () => {
  it("returns parsed content and the model the API reports", async () => {
    const { generator } = createGenerator(okMessage(), "configured-other");

    const result = await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(result).toEqual({ ok: true, content: VALID_CONTENT, model: "claude-test-model" });
  });

  it("concatenates text blocks and ignores thinking blocks", async () => {
    const json = JSON.stringify(VALID_OUTPUT);
    const { generator } = createGenerator(async () =>
      buildMessage({
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "text", text: json.slice(0, 10), citations: null },
          { type: "text", text: json.slice(10), citations: null },
        ],
      })
    );

    const result = await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(result).toEqual({ ok: true, content: VALID_CONTENT, model: "claude-test-model" });
  });

  it("maps a refusal even when the content is valid", async () => {
    const { generator, logger } = createGenerator(async () =>
      textMessage(JSON.stringify(VALID_OUTPUT), {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      })
    );

    const result = await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(result).toEqual({ ok: false, failureCode: "REFUSED", retryable: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ category: "cyber" });
  });

  it("maps truncation and context overflow as final", async () => {
    const truncated = createGenerator(async () => textMessage("{", { stop_reason: "max_tokens" }));
    const tooLong = createGenerator(async () =>
      textMessage("", { stop_reason: "model_context_window_exceeded" })
    );
    const input = { passages: [buildPassage()], languageHint: null };

    expect(await truncated.generator.generate(input)).toEqual({
      ok: false,
      failureCode: "OUTPUT_TRUNCATED",
      retryable: false,
    });
    expect(await tooLong.generator.generate(input)).toEqual({
      ok: false,
      failureCode: "CONTEXT_TOO_LONG",
      retryable: false,
    });
  });

  it.each([
    ["non-JSON text", async () => textMessage("not json")],
    [
      "JSON missing overview",
      async () => textMessage(JSON.stringify({ ...VALID_OUTPUT, overview: undefined })),
    ],
    [
      "JSON with an unknown category",
      async () =>
        textMessage(
          JSON.stringify({ ...VALID_OUTPUT, topics: [{ title: "T", category: "RISK", details: [] }] })
        ),
    ],
    ["JSON in the old v1 shape", async () => textMessage(JSON.stringify(VALID_CONTENT))],
    ["empty content", async () => buildMessage({ content: [] })],
  ])("maps %s to a retryable INVALID_OUTPUT", async (_name, finalMessage) => {
    const { generator } = createGenerator(finalMessage);

    const result = await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(result).toEqual({ ok: false, failureCode: "INVALID_OUTPUT", retryable: true });
  });

  it("logs nothing at warn or error on success", async () => {
    const { generator, logger } = createGenerator(okMessage());

    await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("AnthropicSummaryGenerator errors", () => {
  const cases = [
    [
      "401",
      () => new AuthenticationError(401, undefined, "msg", new Headers()),
      "AUTHENTICATION_FAILED",
      false,
    ],
    [
      "403",
      () => new PermissionDeniedError(403, undefined, "msg", new Headers()),
      "AUTHENTICATION_FAILED",
      false,
    ],
    ["429", () => new RateLimitError(429, undefined, "msg", new Headers()), "RATE_LIMITED", true],
    ["400", () => new BadRequestError(400, undefined, "msg", new Headers()), "INVALID_REQUEST", false],
    ["404", () => new NotFoundError(404, undefined, "msg", new Headers()), "INVALID_REQUEST", false],
    [
      "422",
      () => new UnprocessableEntityError(422, undefined, "msg", new Headers()),
      "INVALID_REQUEST",
      false,
    ],
    ["503", () => new InternalServerError(503, undefined, "msg", new Headers()), "PROVIDER_ERROR", true],
    ["connection", () => new APIConnectionError({ message: "msg" }), "PROVIDER_ERROR", true],
    ["timeout", () => new APIConnectionTimeoutError(), "PROVIDER_ERROR", true],
    ["409", () => new APIError(409, undefined, "msg", new Headers()), "PROVIDER_ERROR", true],
  ] as const;

  it.each(cases)("maps %s from finalMessage", async (_name, makeError, failureCode, retryable) => {
    const { generator, logger } = createGenerator(async () => {
      throw makeError();
    });

    const result = await generator.generate({
      passages: [buildPassage(), buildPassage()],
      languageHint: null,
    });

    expect(result).toEqual({ ok: false, failureCode, retryable });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toBe("Notetaker summary generation failed");
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ failureCode, passageCount: 2 });
  });

  it("maps errors thrown synchronously by stream", async () => {
    const client = {
      messages: {
        stream: vi.fn((_params: MessageStreamParams) => {
          throw new RateLimitError(429, undefined, "msg", new Headers());
        }),
      },
    };
    const generator = new AnthropicSummaryGenerator({ client, model: "m", logger: createLogger() });

    const result = await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(result).toEqual({ ok: false, failureCode: "RATE_LIMITED", retryable: true });
  });

  it("logs the status of an API error", async () => {
    const { generator, logger } = createGenerator(async () => {
      throw new RateLimitError(429, undefined, "msg", new Headers());
    });

    await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      failureCode: "RATE_LIMITED",
      status: 429,
      passageCount: 1,
    });
  });

  it.each([
    ["an Error", () => new Error("boom")],
    ["a non-Error value", () => "boom"],
  ])("maps %s to a retryable UNEXPECTED_ERROR", async (_name, makeThrown) => {
    const { generator } = createGenerator(async () => {
      throw makeThrown();
    });

    const result = await generator.generate({ passages: [buildPassage()], languageHint: null });

    expect(result).toEqual({ ok: false, failureCode: "UNEXPECTED_ERROR", retryable: true });
  });
});

describe("AnthropicSummaryGenerator logging", () => {
  const input = { passages: [buildPassage({ text: `we discussed ${SECRET}` })], languageHint: null };

  function expectNoLeak(logger: ReturnType<typeof createLogger>) {
    const output = allLogOutput(logger);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("echo");
  }

  it("does not leak the error message", async () => {
    const { generator, logger } = createGenerator(async () => {
      throw new BadRequestError(400, undefined, `echo ${SECRET}`, new Headers());
    });

    await generator.generate(input);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectNoLeak(logger);
  });

  it("does not leak model text on invalid output", async () => {
    const { generator, logger } = createGenerator(async () => textMessage(`echo ${SECRET}`));

    await generator.generate(input);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectNoLeak(logger);
  });

  it("does not leak model text on refusal", async () => {
    const { generator, logger } = createGenerator(async () =>
      textMessage(`echo ${SECRET}`, {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null, explanation: `echo ${SECRET}` },
      })
    );

    await generator.generate(input);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectNoLeak(logger);
  });
});
