/** @vitest-environment node */
import { RateLimitError } from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
  BetaStopReason,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { describe, expect, it, vi } from "vitest";
import {
  type AnthropicAgentMessagesClient,
  ClaudeMeetingAgent,
  type IClaudeMeetingAgentDeps,
  MEETING_AGENT_BROWSER_MAX_ITERATIONS,
  MEETING_AGENT_BROWSER_TIME_BUDGET_MS,
  MEETING_AGENT_MAX_ITERATIONS,
  MEETING_AGENT_MAX_OUTPUT_TOKENS,
} from "./ClaudeMeetingAgent";
import type {
  MeetingAgentActions,
  MeetingAgentBrowserActions,
  MeetingAgentBrowserPage,
  MeetingAgentRequest,
} from "./IMeetingAgent";
import { buildMeetingAgentSystemPrompt, buildMeetingAgentUserPrompt } from "./meetingAgentPrompt";

const MODEL = "claude-test-model";
const SECRET = "zxqvsecretproviderdetail";

const REQUEST: MeetingAgentRequest = {
  command: "what is the weather in Paris?",
  speakerName: "Anna",
  source: "CHAT",
  recentLines: [],
};

function buildMessage(stopReason: BetaStopReason, content: BetaContentBlock[]): BetaMessage {
  return {
    id: "msg_test",
    container: null,
    content,
    context_management: null,
    diagnostics: null,
    model: MODEL,
    role: "assistant",
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 10,
      iterations: null,
      output_tokens: 10,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

function textBlock(text: string): BetaContentBlock {
  return { type: "text", text, citations: null };
}

function toolUse(id: string, name: string, input: unknown): BetaContentBlock {
  return { type: "tool_use", id, name, input };
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
}

function createActions() {
  return {
    sendChatMessage: vi.fn<MeetingAgentActions["sendChatMessage"]>().mockResolvedValue(undefined),
    startScreenshare: vi.fn<MeetingAgentActions["startScreenshare"]>().mockResolvedValue(undefined),
    stopScreenshare: vi.fn<MeetingAgentActions["stopScreenshare"]>().mockResolvedValue(undefined),
  } satisfies MeetingAgentActions;
}

const PAGE: MeetingAgentBrowserPage = {
  url: "https://cal.com/pricing",
  title: "Pricing",
  snapshot: "[e1] link Teams",
  screenshot: null,
};

function createBrowser() {
  return {
    open: vi.fn<MeetingAgentBrowserActions["open"]>().mockResolvedValue(PAGE),
    perform: vi.fn<MeetingAgentBrowserActions["perform"]>().mockResolvedValue(PAGE),
    close: vi.fn<MeetingAgentBrowserActions["close"]>().mockResolvedValue(undefined),
  } satisfies MeetingAgentBrowserActions;
}

function toolNames(request: BetaMessageCreateParamsNonStreaming): Array<string | undefined> {
  return (request.tools ?? []).map((tool) => ("name" in tool ? tool.name : undefined));
}

function setup(
  responses: Array<BetaMessage | Error>,
  extraDeps: Pick<IClaudeMeetingAgentDeps, "browserVision" | "now"> = {}
) {
  // The agent keeps appending to the same messages array, so each request is cloned at call time.
  const requests: BetaMessageCreateParamsNonStreaming[] = [];
  let index = 0;
  const create = vi.fn(async (params: BetaMessageCreateParamsNonStreaming): Promise<BetaMessage> => {
    requests.push(structuredClone(params));
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  const client: AnthropicAgentMessagesClient = { beta: { messages: { create } } };
  const logger = createLogger();
  const actions = createActions();
  const agent = new ClaudeMeetingAgent({ client, model: MODEL, logger, ...extraDeps });
  return { agent, create, requests, logger, actions };
}

function lastMessage(request: BetaMessageCreateParamsNonStreaming) {
  return request.messages[request.messages.length - 1];
}

function toolResultsOf(request: BetaMessageCreateParamsNonStreaming): BetaToolResultBlockParam[] {
  const message = lastMessage(request);
  expect(message.role).toBe("user");
  if (typeof message.content === "string") throw new Error("Expected tool_result blocks, got a string");
  return message.content.filter((block): block is BetaToolResultBlockParam => block.type === "tool_result");
}

describe("ClaudeMeetingAgent", () => {
  it("sends the expected request params", async () => {
    const { agent, requests, actions } = setup([buildMessage("end_turn", [textBlock("Sunny.")])]);

    await agent.run(REQUEST, actions);

    expect(requests).toHaveLength(1);
    const params = requests[0];
    expect(params.model).toBe(MODEL);
    expect(params.max_tokens).toBe(MEETING_AGENT_MAX_OUTPUT_TOKENS);
    expect(params.max_tokens).toBe(2048);
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.betas).toContain("server-side-fallback-2026-07-01");
    expect(params.fallbacks).toBe("default");
    expect(params).not.toHaveProperty("thinking");

    const tools = params.tools ?? [];
    expect(tools).toHaveLength(5);
    const clientTools = tools.slice(0, 3);
    expect(clientTools.map((tool) => ("name" in tool ? tool.name : undefined))).toEqual([
      "send_chat_message",
      "share_screen",
      "stop_screen_share",
    ]);
    for (const tool of clientTools) expect(tool).toMatchObject({ strict: true });
    expect(tools.slice(3).map((tool) => ("type" in tool ? tool.type : undefined))).toEqual([
      "web_search_20260209",
      "web_fetch_20260209",
    ]);

    expect(params.messages[0]).toEqual({ role: "user", content: buildMeetingAgentUserPrompt(REQUEST) });
  });

  it("executes send_chat_message, returns a tool_result and completes without a fallback post", async () => {
    const { agent, requests, actions } = setup([
      buildMessage("tool_use", [toolUse("toolu_1", "send_chat_message", { text: "It is sunny." })]),
      buildMessage("end_turn", [textBlock("Done.")]),
    ]);

    const result = await agent.run(REQUEST, actions);

    expect(actions.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(actions.sendChatMessage).toHaveBeenCalledWith("It is sunny.");
    const results = toolResultsOf(requests[1]);
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe("toolu_1");
    expect(results[0].is_error).toBeUndefined();
    expect(result).toEqual({ outcome: "COMPLETED", iterations: 2, chatMessagesSent: 1 });
  });

  it("rejects a non-https share_screen URL without starting the screenshare", async () => {
    const { agent, requests, actions } = setup([
      buildMessage("tool_use", [toolUse("toolu_1", "share_screen", { url: "http://example.com" })]),
      buildMessage("end_turn", []),
    ]);

    await agent.run(REQUEST, actions);

    expect(actions.startScreenshare).not.toHaveBeenCalled();
    const [result] = toolResultsOf(requests[1]);
    expect(result).toMatchObject({ tool_use_id: "toolu_1", is_error: true });
  });

  it("starts the screenshare for an https URL", async () => {
    const { agent, requests, actions } = setup([
      buildMessage("tool_use", [toolUse("toolu_1", "share_screen", { url: "https://example.com/page" })]),
      buildMessage("end_turn", []),
    ]);

    await agent.run(REQUEST, actions);

    expect(actions.startScreenshare).toHaveBeenCalledWith("https://example.com/page");
    const [result] = toolResultsOf(requests[1]);
    expect(result.is_error).toBeUndefined();
  });

  it("stops the screenshare", async () => {
    const { agent, requests, actions } = setup([
      buildMessage("tool_use", [toolUse("toolu_1", "stop_screen_share", {})]),
      buildMessage("end_turn", []),
    ]);

    await agent.run(REQUEST, actions);

    expect(actions.stopScreenshare).toHaveBeenCalledTimes(1);
    const [result] = toolResultsOf(requests[1]);
    expect(result.is_error).toBeUndefined();
  });

  it("hides the exception text from the model when an action throws and keeps looping", async () => {
    const { agent, requests, actions } = setup([
      buildMessage("tool_use", [toolUse("toolu_1", "share_screen", { url: "https://example.com" })]),
      buildMessage("end_turn", [textBlock("Sorry, I could not share that page.")]),
    ]);
    actions.startScreenshare.mockRejectedValueOnce(new Error(SECRET));

    const result = await agent.run(REQUEST, actions);

    const [toolResult] = toolResultsOf(requests[1]);
    expect(toolResult).toMatchObject({ tool_use_id: "toolu_1", is_error: true });
    expect(JSON.stringify(toolResult.content)).not.toContain(SECRET);
    expect(requests).toHaveLength(2);
    expect(actions.sendChatMessage).toHaveBeenCalledWith("Sorry, I could not share that page.");
    expect(result.outcome).toBe("COMPLETED");
  });

  it("returns every tool_result of one response in a single user message", async () => {
    const { agent, requests, actions } = setup([
      buildMessage("tool_use", [
        textBlock("On it."),
        toolUse("toolu_1", "share_screen", { url: "https://example.com" }),
        toolUse("toolu_2", "send_chat_message", { text: "Sharing now." }),
      ]),
      buildMessage("end_turn", []),
    ]);

    await agent.run(REQUEST, actions);

    const second = requests[1];
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1].role).toBe("assistant");
    expect(toolResultsOf(second).map((block) => block.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
  });

  it("continues a pause_turn with the assistant content appended and no new user message", async () => {
    const pausedContent: BetaContentBlock[] = [
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "weather Paris" },
      },
    ];
    const { agent, requests, create, actions } = setup([
      buildMessage("pause_turn", pausedContent),
      buildMessage("end_turn", [textBlock("Sunny.")]),
    ]);

    await agent.run(REQUEST, actions);

    expect(create).toHaveBeenCalledTimes(2);
    const second = requests[1];
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toEqual({ role: "assistant", content: pausedContent });
  });

  it("posts the final text when no chat message was sent and passes server blocks back unchanged", async () => {
    const serverContent: BetaContentBlock[] = [
      {
        type: "fallback",
        from: { model: "claude-requested" },
        to: { model: "claude-substitute" },
        trigger: { type: "refusal", category: null },
      },
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "weather Paris" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            encrypted_content: "enc",
            page_age: null,
            title: "Paris weather",
            url: "https://example.com/weather",
          },
        ],
      },
    ];
    const { agent, requests, actions } = setup([
      buildMessage("tool_use", [...serverContent, toolUse("toolu_1", "stop_screen_share", {})]),
      buildMessage("end_turn", [...serverContent, textBlock("It is "), textBlock("sunny. ")]),
    ]);

    const result = await agent.run(REQUEST, actions);

    expect(requests[1].messages[1]).toEqual({
      role: "assistant",
      content: [...serverContent, toolUse("toolu_1", "stop_screen_share", {})],
    });
    expect(actions.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(actions.sendChatMessage).toHaveBeenCalledWith("It is sunny.");
    expect(result).toEqual({ outcome: "COMPLETED", iterations: 2, chatMessagesSent: 1 });
  });

  it("does not post anything when the final response has no text", async () => {
    const { agent, actions } = setup([buildMessage("end_turn", [])]);

    const result = await agent.run(REQUEST, actions);

    expect(actions.sendChatMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "COMPLETED", iterations: 1, chatMessagesSent: 0 });
  });

  it("returns REFUSED without sending a chat message", async () => {
    const { agent, actions } = setup([buildMessage("refusal", [textBlock("I can't help with that.")])]);

    const result = await agent.run(REQUEST, actions);

    expect(result).toEqual({ outcome: "REFUSED", iterations: 1, chatMessagesSent: 0 });
    expect(actions.sendChatMessage).not.toHaveBeenCalled();
  });

  it("stops at the iteration cap with LOOP_LIMIT", async () => {
    const { agent, create, actions } = setup([
      buildMessage("tool_use", [toolUse("toolu_1", "stop_screen_share", {})]),
    ]);

    const result = await agent.run(REQUEST, actions);

    expect(MEETING_AGENT_MAX_ITERATIONS).toBe(6);
    expect(create).toHaveBeenCalledTimes(6);
    expect(result).toEqual({ outcome: "LOOP_LIMIT", iterations: 6, chatMessagesSent: 0 });
  });

  // SDK error classes do not override `name`, so an APIError is distinguished by its status instead.
  it.each([
    ["a plain Error", () => new Error(SECRET), "Error", undefined],
    ["an SDK APIError", () => new RateLimitError(429, undefined, SECRET, new Headers()), "Error", 429],
  ])("returns FAILED without throwing on %s and logs no message text", async (_label, makeError, errorName, status) => {
    const { agent, logger, actions } = setup([makeError()]);

    const result = await agent.run(REQUEST, actions);

    expect(result).toEqual({ outcome: "FAILED", iterations: 1, chatMessagesSent: 0 });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("Meeting agent run failed", { errorName, status });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET);
    expect(actions.sendChatMessage).not.toHaveBeenCalled();
  });

  describe("browser mode", () => {
    const BROWSER_REQUEST: MeetingAgentRequest = { ...REQUEST, command: "open cal.com pricing" };

    it("offers send_chat_message, the browser tools and the server tools with the browser prompt", async () => {
      const { agent, requests, actions } = setup([buildMessage("end_turn", [])]);

      await agent.run(BROWSER_REQUEST, { ...actions, browser: createBrowser() });

      const params = requests[0];
      expect(params.system).toBe(buildMeetingAgentSystemPrompt({ browser: true }));
      expect(toolNames(params)).toEqual([
        "send_chat_message",
        "browser_open",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_press",
        "browser_scroll",
        "browser_back",
        "browser_close",
        "web_search",
        "web_fetch",
      ]);
    });

    it("adds browser_screenshot only when vision is enabled", async () => {
      const { agent, requests, actions } = setup([buildMessage("end_turn", [])], { browserVision: true });

      await agent.run(BROWSER_REQUEST, { ...actions, browser: createBrowser() });

      expect(toolNames(requests[0])).toContain("browser_screenshot");
    });

    it("keeps the classic tools and prompt when the browser is null", async () => {
      const { agent, requests, actions } = setup([buildMessage("end_turn", [])]);

      await agent.run(REQUEST, { ...actions, browser: null });

      expect(requests[0].system).toBe(buildMeetingAgentSystemPrompt());
      expect(toolNames(requests[0]).slice(0, 3)).toEqual([
        "send_chat_message",
        "share_screen",
        "stop_screen_share",
      ]);
    });

    it("rejects browser tools in classic mode", async () => {
      const { agent, requests, actions } = setup([
        buildMessage("tool_use", [toolUse("toolu_1", "browser_snapshot", {})]),
        buildMessage("end_turn", []),
      ]);

      await agent.run(REQUEST, actions);

      const [result] = toolResultsOf(requests[1]);
      expect(result).toMatchObject({ tool_use_id: "toolu_1", content: "Unknown tool.", is_error: true });
    });

    it("opens a page mentioned in the command and returns its snapshot", async () => {
      const browser = createBrowser();
      const { agent, requests, actions } = setup([
        buildMessage("tool_use", [toolUse("toolu_1", "browser_open", { url: "https://cal.com/pricing" })]),
        buildMessage("end_turn", []),
      ]);

      await agent.run(BROWSER_REQUEST, { ...actions, browser });

      expect(browser.open).toHaveBeenCalledWith("https://cal.com/pricing");
      const [result] = toolResultsOf(requests[1]);
      expect(result.is_error).toBeUndefined();
      expect(result.content).toBe("URL: https://cal.com/pricing\nTitle: Pricing\n[e1] link Teams");
    });

    it("refuses to open a host nobody mentioned", async () => {
      const browser = createBrowser();
      const { agent, requests, actions } = setup([
        buildMessage("tool_use", [toolUse("toolu_1", "browser_open", { url: "https://evil.example/x" })]),
        buildMessage("end_turn", []),
      ]);

      await agent.run(BROWSER_REQUEST, { ...actions, browser });

      expect(browser.open).not.toHaveBeenCalled();
      expect(toolResultsOf(requests[1])[0]).toMatchObject({ is_error: true });
    });

    it("allows a host found by web search earlier in the run", async () => {
      const browser = createBrowser();
      const { agent, actions } = setup([
        buildMessage("tool_use", [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                encrypted_content: "enc",
                page_age: null,
                title: "Docs",
                url: "https://docs.example.org/start",
              },
            ],
          },
          toolUse("toolu_1", "browser_open", { url: "https://docs.example.org/start" }),
        ]),
        buildMessage("end_turn", []),
      ]);

      await agent.run(BROWSER_REQUEST, { ...actions, browser });

      expect(browser.open).toHaveBeenCalledWith("https://docs.example.org/start");
    });

    it("maps share_screen to browser_open and stop_screen_share to browser_close", async () => {
      const browser = createBrowser();
      const { agent, actions } = setup([
        buildMessage("tool_use", [
          toolUse("toolu_1", "share_screen", { url: "https://cal.com/pricing" }),
          toolUse("toolu_2", "stop_screen_share", {}),
        ]),
        buildMessage("end_turn", []),
      ]);

      await agent.run(BROWSER_REQUEST, { ...actions, browser });

      expect(browser.open).toHaveBeenCalledWith("https://cal.com/pricing");
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(actions.startScreenshare).not.toHaveBeenCalled();
      expect(actions.stopScreenshare).not.toHaveBeenCalled();
    });

    it("passes an array tool_result with the screenshot image through", async () => {
      const browser = createBrowser();
      browser.perform.mockResolvedValue({ ...PAGE, screenshot: { mediaType: "image/jpeg", base64: "aGk=" } });
      const { agent, requests, actions } = setup(
        [
          buildMessage("tool_use", [toolUse("toolu_1", "browser_screenshot", {})]),
          buildMessage("end_turn", []),
        ],
        { browserVision: true }
      );

      await agent.run(BROWSER_REQUEST, { ...actions, browser });

      expect(browser.perform).toHaveBeenCalledWith({ type: "screenshot" });
      const [result] = toolResultsOf(requests[1]);
      expect(result.content).toEqual([
        { type: "text", text: "URL: https://cal.com/pricing\nTitle: Pricing\n[e1] link Teams" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGk=" } },
      ]);
    });

    it("allows 12 iterations before LOOP_LIMIT", async () => {
      const { agent, create, actions } = setup([
        buildMessage("tool_use", [toolUse("toolu_1", "browser_snapshot", {})]),
      ]);

      const result = await agent.run(BROWSER_REQUEST, { ...actions, browser: createBrowser() });

      expect(MEETING_AGENT_BROWSER_MAX_ITERATIONS).toBe(12);
      expect(create).toHaveBeenCalledTimes(12);
      expect(result).toEqual({ outcome: "LOOP_LIMIT", iterations: 12, chatMessagesSent: 0 });
    });

    it("returns LOOP_LIMIT once the wall-clock budget is spent", async () => {
      let clock = 0;
      const { agent, create, actions } = setup(
        [buildMessage("tool_use", [toolUse("toolu_1", "browser_snapshot", {})])],
        { now: () => clock }
      );
      create.mockImplementation(async () => {
        clock += 50_000;
        return buildMessage("tool_use", [toolUse("toolu_1", "browser_snapshot", {})]);
      });

      const result = await agent.run(BROWSER_REQUEST, { ...actions, browser: createBrowser() });

      expect(MEETING_AGENT_BROWSER_TIME_BUDGET_MS).toBe(120_000);
      expect(create).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ outcome: "LOOP_LIMIT", iterations: 3, chatMessagesSent: 0 });
    });

    it("ignores the wall-clock budget in classic mode", async () => {
      let clock = 0;
      const { agent, create, actions } = setup(
        [buildMessage("tool_use", [toolUse("toolu_1", "stop_screen_share", {})])],
        { now: () => clock }
      );
      create.mockImplementation(async () => {
        clock += 50_000;
        return buildMessage("tool_use", [toolUse("toolu_1", "stop_screen_share", {})]);
      });

      const result = await agent.run(REQUEST, actions);

      expect(create).toHaveBeenCalledTimes(MEETING_AGENT_MAX_ITERATIONS);
      expect(result.outcome).toBe("LOOP_LIMIT");
    });
  });
});
