import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IMeetingAgent, MeetingAgentActions, MeetingAgentRunResult } from "../agent/IMeetingAgent";
import { MeetingAgentStateStore } from "../agent/MeetingAgentStateStore";
import type {
  IMeetingAgentSpeechSynthesizer,
  SynthesizedSpeech,
} from "../agent/tts/IMeetingAgentSpeechSynthesizer";
import { createSpeechSynthesisError } from "../agent/tts/IMeetingAgentSpeechSynthesizer";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import type { RecallRealtimeEnvelope } from "../bot/recall/recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "../bot/recall/recallSchemas";
import type { IAgentBrowserGateway } from "../browser/IAgentBrowserGateway";
import { MeetingAgentBrowserService } from "../browser/MeetingAgentBrowserService";
import { getNotetakerConfig } from "../lib/config";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { MAX_SPEECH_WAIT_MS, RecallRealtimeEventService } from "./RecallRealtimeEventService";

const BOT_ID = "bot-1";
const SESSION_ID = "session-1";
const DISPLAY_NAME = "BlueBee Notetaker";
const START = new Date("2026-11-20T10:00:00.000Z");
const ALICE = { id: 1, name: "Alice" };
const BOB = { id: 2, name: "Bob" };

const COMPLETED: MeetingAgentRunResult = { outcome: "COMPLETED", iterations: 1, chatMessagesSent: 0 };
const SPEECH: SynthesizedSpeech = { kind: "mp3", base64: "QUJD", durationMs: 3_000 };

type Participant = { id: number; name: string | null };

function buildSession(patch: Partial<NotetakerSessionRecord> = {}): NotetakerSessionRecord {
  return {
    id: SESSION_ID,
    bookingId: 100,
    status: "TRANSCRIBING",
    outcomeReason: null,
    platform: "GOOGLE_MEET",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    botProvider: "RECALL",
    externalRef: BOT_ID,
    displayName: DISPLAY_NAME,
    scheduledStartAt: START,
    dispatchedAt: START,
    joinRequestedAt: START,
    admittedAt: START,
    noticePostedAt: null,
    endedAt: null,
    startedLate: false,
    rejoinAttempted: false,
    interruptedAtMs: null,
    lastHeartbeatAt: null,
    lastEventSequence: 0,
    stopRequestedAt: null,
    stopRequestedByUserId: null,
    resultsDeletedAt: null,
    colleagueSharingDisclosed: false,
    createdAt: START,
    ...patch,
  };
}

function botOf(metadata: Record<string, unknown> | null = { [RECALL_SESSION_METADATA_KEY]: SESSION_ID }) {
  return { id: BOT_ID, metadata };
}

function chatEnvelope(
  text: string,
  participant: Participant = ALICE,
  bot: RecallRealtimeEnvelope["data"]["bot"] = botOf()
): RecallRealtimeEnvelope {
  return {
    event: "participant_events.chat_message",
    data: { data: { participant, data: { text, to: "everyone" } }, bot },
  };
}

function speechEnvelope(
  text: string,
  participant: Participant = ALICE,
  bot: RecallRealtimeEnvelope["data"]["bot"] = botOf()
): RecallRealtimeEnvelope {
  return {
    event: "transcript.data",
    data: { data: { participant, words: text.split(" ").map((word) => ({ text: word })) }, bot },
  };
}

function speechOnEnvelope(
  participant: Participant = ALICE,
  bot: RecallRealtimeEnvelope["data"]["bot"] = botOf()
): RecallRealtimeEnvelope {
  return { event: "participant_events.speech_on", data: { data: { participant }, bot } };
}

function partialEnvelope(
  text: string,
  participant: Participant = ALICE,
  bot: RecallRealtimeEnvelope["data"]["bot"] = botOf()
): RecallRealtimeEnvelope {
  const words = text === "" ? [] : text.split(" ").map((word) => ({ text: word }));
  return { event: "transcript.partial_data", data: { data: { participant, words }, bot } };
}

function createFakeRecallClient() {
  return {
    createBot: vi.fn<IRecallApiClient["createBot"]>(),
    retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>(),
    listBotsByMetadata: vi.fn<IRecallApiClient["listBotsByMetadata"]>(),
    leaveCall: vi.fn<IRecallApiClient["leaveCall"]>(),
    deleteScheduledBot: vi.fn<IRecallApiClient["deleteScheduledBot"]>(),
    sendChatMessage: vi.fn<IRecallApiClient["sendChatMessage"]>().mockResolvedValue(undefined),
    outputAudio: vi.fn<IRecallApiClient["outputAudio"]>().mockResolvedValue(undefined),
    stopOutputAudio: vi.fn<IRecallApiClient["stopOutputAudio"]>().mockResolvedValue("OK"),
    startScreenshare: vi.fn<IRecallApiClient["startScreenshare"]>().mockResolvedValue(undefined),
    stopScreenshare: vi.fn<IRecallApiClient["stopScreenshare"]>().mockResolvedValue("OK"),
    createTranscript: vi.fn<IRecallApiClient["createTranscript"]>(),
    retrieveTranscript: vi.fn<IRecallApiClient["retrieveTranscript"]>(),
    downloadTranscript: vi.fn<IRecallApiClient["downloadTranscript"]>(),
    listTranscriptsByRecording: vi.fn<IRecallApiClient["listTranscriptsByRecording"]>(),
  } satisfies IRecallApiClient;
}

function createLogger() {
  return {
    debug: vi.fn<ISimpleLogger["debug"]>(),
    error: vi.fn<ISimpleLogger["error"]>(),
    info: vi.fn<ISimpleLogger["info"]>(),
    warn: vi.fn<ISimpleLogger["warn"]>(),
  } satisfies ISimpleLogger;
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  options: {
    agentEnabled?: boolean;
    maxCommandsPerMeeting?: number;
    session?: NotetakerSessionRecord | null;
    voice?: boolean;
    agentBrowser?: MeetingAgentBrowserService;
  } = {}
) {
  const repositories = createInMemoryNotetakerRepositories();
  const session = options.session === undefined ? buildSession() : options.session;
  if (session) repositories.store.sessions.set(session.id, session);

  const recallClient = createFakeRecallClient();
  const logger = createLogger();
  const run = vi.fn<IMeetingAgent["run"]>().mockResolvedValue(COMPLETED);
  const meetingAgent: IMeetingAgent = { run };
  const config = getNotetakerConfig({
    NODE_ENV: "test",
    NOTETAKER_AGENT_MAX_COMMANDS_PER_MEETING:
      options.maxCommandsPerMeeting === undefined ? undefined : String(options.maxCommandsPerMeeting),
  });

  let current = START;
  const advance = (ms: number) => {
    current = new Date(current.getTime() + ms);
  };
  const synthesize = vi.fn<IMeetingAgentSpeechSynthesizer["synthesize"]>().mockResolvedValue(SPEECH);
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

  const service = new RecallRealtimeEventService(
    {
      recallClient,
      sessionRepository: repositories.sessionRepository,
      meetingAgent: options.agentEnabled === false ? null : meetingAgent,
      speechSynthesizer: options.voice ? { synthesize } : null,
      agentBrowser: options.agentBrowser ?? null,
      config,
      logger,
    },
    { store: new MeetingAgentStateStore(), now: () => current, sleep }
  );

  return { service, recallClient, logger, run, advance, synthesize, sleep };
}

function sentMessages(recallClient: ReturnType<typeof createFakeRecallClient>): string[] {
  return recallClient.sendChatMessage.mock.calls.map(([, body]) => body.message);
}

describe("RecallRealtimeEventService", () => {
  it("is disabled when no meeting agent is configured", async () => {
    const { service, recallClient } = setup({ agentEnabled: false });

    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1")).resolves.toBe("DISABLED");
    expect(recallClient.sendChatMessage).not.toHaveBeenCalled();
  });

  it("buffers non-trigger chat and passes it to a later command as recent lines", async () => {
    const { service, run } = setup();

    await expect(service.handle(chatEnvelope("Hello team"), "d-1")).resolves.toBe("BUFFERED");
    expect(run).not.toHaveBeenCalled();

    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise the call"), "d-2")).resolves.toBe(
      "HANDLED"
    );
    expect(run).toHaveBeenCalledTimes(1);
    const [request] = run.mock.calls[0];
    expect(request).toEqual({
      command: "summarise the call",
      speakerName: "Alice",
      source: "CHAT",
      recentLines: [{ source: "CHAT", speakerName: "Alice", text: "Hello team", at: START }],
    });
  });

  it("runs the agent for a spoken trigger built from transcript words", async () => {
    const { service, run } = setup();

    await expect(service.handle(speechEnvelope("Blue Bee Bot, what is next?", BOB), null)).resolves.toBe(
      "HANDLED"
    );
    expect(run).toHaveBeenCalledWith(
      { command: "what is next?", speakerName: "Bob", source: "SPEECH", recentLines: [] },
      expect.anything()
    );
  });

  it("treats the next utterance of a speaker who said only the name as the command", async () => {
    const { service, run, advance } = setup();

    await expect(service.handle(speechEnvelope("BlueBeeBot,"), null)).resolves.toBe("BUFFERED");
    advance(5_000);
    await expect(service.handle(speechEnvelope("show the agenda"), null)).resolves.toBe("HANDLED");

    expect(run).toHaveBeenCalledTimes(1);
    const [request] = run.mock.calls[0];
    expect(request.command).toBe("show the agenda");
    expect(request.source).toBe("SPEECH");
    expect(request.recentLines.map((line) => line.text)).toEqual(["BlueBeeBot,"]);
  });

  it("does not treat an utterance as the command once the pending trigger expired", async () => {
    const { service, run, advance } = setup();

    await service.handle(speechEnvelope("BlueBeeBot,"), null);
    advance(16_000);

    await expect(service.handle(speechEnvelope("show the agenda"), null)).resolves.toBe("BUFFERED");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not let another participant's utterance consume a pending trigger", async () => {
    const { service, run } = setup();

    await service.handle(speechEnvelope("BlueBeeBot,", ALICE), null);

    await expect(service.handle(speechEnvelope("show the agenda", BOB), null)).resolves.toBe("BUFFERED");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a repeated delivery id as a duplicate", async () => {
    const { service, run } = setup();

    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1")).resolves.toBe("HANDLED");
    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1")).resolves.toBe("DUPLICATE");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports the same command repeated within ten seconds as a duplicate", async () => {
    const { service, run, advance } = setup();

    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1")).resolves.toBe("HANDLED");
    advance(5_000);
    await expect(service.handle(speechEnvelope("BlueBeeBot, summarise"), "d-2")).resolves.toBe("DUPLICATE");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores the bot's own chat message when Recall echoes it back", async () => {
    const { service, run } = setup();
    run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
      await actions.sendChatMessage("The next topic is hiring.");
      return COMPLETED;
    });

    await service.handle(chatEnvelope("BlueBeeBot, what is next?"), "d-1");

    await expect(service.handle(chatEnvelope("The next topic is hiring.", BOB), "d-2")).resolves.toBe(
      "IGNORED"
    );
    await expect(service.handle(chatEnvelope("Something else", BOB), "d-3")).resolves.toBe("BUFFERED");
  });

  it("ignores chat from a participant carrying the bot's display name", async () => {
    const { service, run } = setup();

    await expect(
      service.handle(chatEnvelope("BlueBeeBot, summarise", { id: 9, name: DISPLAY_NAME }), "d-1")
    ).resolves.toBe("IGNORED");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["the session is unknown", null],
    ["the session has ended", buildSession({ status: "READY" })],
    ["the session is not a Recall session", buildSession({ botProvider: "FAKE" })],
    ["the session belongs to another bot", buildSession({ externalRef: "bot-2" })],
  ])("ignores commands when %s", async (_label, session) => {
    const { service, run, recallClient } = setup({ session });

    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1")).resolves.toBe("IGNORED");
    expect(run).not.toHaveBeenCalled();
    expect(recallClient.sendChatMessage).not.toHaveBeenCalled();
  });

  it("ignores events whose bot carries no session metadata", async () => {
    const { service, run } = setup();

    await expect(
      service.handle(chatEnvelope("BlueBeeBot, summarise", ALICE, botOf({})), "d-1")
    ).resolves.toBe("IGNORED");
    await expect(
      service.handle(chatEnvelope("BlueBeeBot, summarise", ALICE, botOf(null)), "d-2")
    ).resolves.toBe("IGNORED");
    expect(run).not.toHaveBeenCalled();
  });

  it("rate limits the fifth command within a minute without posting a notice", async () => {
    const { service, run, recallClient, advance } = setup();

    for (let index = 1; index <= 4; index++) {
      await expect(service.handle(chatEnvelope(`BlueBeeBot, task ${index}`), `d-${index}`)).resolves.toBe(
        "HANDLED"
      );
      advance(1_000);
    }

    await expect(service.handle(chatEnvelope("BlueBeeBot, task 5"), "d-5")).resolves.toBe("RATE_LIMITED");
    expect(run).toHaveBeenCalledTimes(4);
    expect(recallClient.sendChatMessage).not.toHaveBeenCalled();

    advance(60_000);
    await expect(service.handle(chatEnvelope("BlueBeeBot, task 6"), "d-6")).resolves.toBe("HANDLED");
  });

  it("rate limits commands past the meeting limit and posts the notice once", async () => {
    const { service, run, recallClient, advance } = setup({ maxCommandsPerMeeting: 2 });

    for (let index = 1; index <= 5; index++) {
      const outcome = await service.handle(chatEnvelope(`BlueBeeBot, task ${index}`), `d-${index}`);
      expect(outcome).toBe(index <= 2 ? "HANDLED" : "RATE_LIMITED");
      advance(30_000);
    }

    expect(run).toHaveBeenCalledTimes(2);
    expect(sentMessages(recallClient)).toEqual(["Command limit reached for this meeting."]);
  });

  it("splits long replies into chat-sized parts without the agent's name", async () => {
    const { service, run, recallClient } = setup();
    const sentence = "This sentence is part of a long agent reply. ";
    const reply = `BlueBeeBot: ${sentence.repeat(30)}`.slice(0, 1200);
    expect(reply).toHaveLength(1200);
    run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
      await actions.sendChatMessage(reply);
      return COMPLETED;
    });

    await service.handle(chatEnvelope("BlueBeeBot, explain everything"), "d-1");

    const calls = recallClient.sendChatMessage.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [botId, body] of calls) {
      expect(botId).toBe(BOT_ID);
      expect(body.to).toBe("everyone");
      expect(body.message.length).toBeLessThanOrEqual(500);
      expect(body.message.startsWith("BlueBeeBot")).toBe(false);
    }
  });

  it("forwards screenshare actions to the Recall client for the bot", async () => {
    const { service, run, recallClient } = setup();
    run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
      await actions.startScreenshare("https://example.com/slides");
      await actions.stopScreenshare();
      return COMPLETED;
    });

    await service.handle(chatEnvelope("BlueBeeBot, share the slides"), "d-1");

    expect(recallClient.startScreenshare).toHaveBeenCalledWith(BOT_ID, "https://example.com/slides");
    expect(recallClient.stopScreenshare).toHaveBeenCalledWith(BOT_ID);
  });

  it("passes no browser to the agent when the agent browser is not usable", async () => {
    const { service, run } = setup();

    await service.handle(chatEnvelope("BlueBeeBot, open the pricing page"), "d-1");

    expect(run.mock.calls[0][1].browser).toBeNull();
  });

  it("passes browser actions bound to the bot when the agent browser is usable", async () => {
    const gateway = {
      perform: vi.fn<IAgentBrowserGateway["perform"]>().mockResolvedValue({
        created: true,
        url: "https://example.com/",
        title: "Example",
        snapshot: "Elements:",
        viewers: 1,
        screenshot: null,
      }),
      closeSession: vi.fn<IAgentBrowserGateway["closeSession"]>().mockResolvedValue(undefined),
      buildViewerUrl: vi.fn<IAgentBrowserGateway["buildViewerUrl"]>(),
    } satisfies IAgentBrowserGateway;
    const agentBrowser = new MeetingAgentBrowserService({
      gateway,
      recallClient: createFakeRecallClient(),
      logger: createLogger(),
    });
    const forBot = vi.spyOn(agentBrowser, "forBot");
    const { service, run } = setup({ agentBrowser });
    run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
      await actions.browser?.open("https://example.com");
      return COMPLETED;
    });

    await service.handle(chatEnvelope("BlueBeeBot, open example.com"), "d-1");

    expect(forBot).toHaveBeenCalledWith(BOT_ID);
    expect(run.mock.calls[0][1].browser).not.toBeNull();
    expect(gateway.perform).toHaveBeenCalledWith(BOT_ID, { type: "goto", url: "https://example.com" });
  });

  it("posts an apology when the agent run fails", async () => {
    const { service, run, recallClient } = setup();
    run.mockResolvedValueOnce({ outcome: "FAILED", iterations: 1, chatMessagesSent: 0 });

    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1")).resolves.toBe("HANDLED");
    expect(sentMessages(recallClient)).toEqual(["Sorry, I could not complete that."]);
  });

  it("does not throw when the agent run throws", async () => {
    const { service, run, logger } = setup();
    run.mockRejectedValueOnce(new Error("model unavailable"));

    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1")).resolves.toBe("HANDLED");
    expect(logger.warn).toHaveBeenCalledWith(
      "Meeting agent run failed",
      expect.objectContaining({ botId: BOT_ID, sessionId: SESSION_ID, outcome: "FAILED" })
    );
  });

  it("runs commands for the same bot one after another", async () => {
    const { service, run } = setup();
    const first = createDeferred<MeetingAgentRunResult>();
    const second = createDeferred<MeetingAgentRunResult>();
    run.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstHandle = service.handle(chatEnvelope("BlueBeeBot, task one"), "d-1");
    const secondHandle = service.handle(chatEnvelope("BlueBeeBot, task two", BOB), "d-2");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(1);

    first.resolve(COMPLETED);
    await expect(firstHandle).resolves.toBe("HANDLED");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][0].command).toBe("task two");

    second.resolve(COMPLETED);
    await expect(secondHandle).resolves.toBe("HANDLED");
  });

  it("passes the bot's earlier reply to a later command as an agent line", async () => {
    const { service, run, advance } = setup();
    run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
      await actions.sendChatMessage("BlueBeeBot: Answer one");
      return COMPLETED;
    });

    await service.handle(chatEnvelope("BlueBeeBot, first question"), "d-1");
    expect(run.mock.calls[0][0].recentLines).toEqual([]);
    advance(1_000);
    await expect(service.handle(chatEnvelope("Answer one", BOB), "d-2")).resolves.toBe("IGNORED");
    advance(1_000);
    await service.handle(chatEnvelope("BlueBeeBot, second question", BOB), "d-3");

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].recentLines).toEqual([
      { source: "CHAT", speakerName: "Alice", text: "BlueBeeBot, first question", at: START },
      { source: "AGENT", speakerName: null, text: "Answer one", at: START },
    ]);
  });

  it("does not record a reply whose sending failed", async () => {
    const { service, run, recallClient, advance } = setup();
    recallClient.sendChatMessage.mockRejectedValueOnce(new Error("chat unavailable"));
    run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
      await actions.sendChatMessage("Answer one");
      return COMPLETED;
    });

    await service.handle(chatEnvelope("BlueBeeBot, first question"), "d-1");
    advance(1_000);
    await service.handle(chatEnvelope("BlueBeeBot, second question"), "d-2");

    expect(run.mock.calls[1][0].recentLines.map((line) => line.source)).toEqual(["CHAT"]);
  });

  it("does not record the limit notice or the apology as agent lines", async () => {
    const appendLine = vi.spyOn(MeetingAgentStateStore.prototype, "appendLine");
    const { service, run, recallClient, advance } = setup({ maxCommandsPerMeeting: 2 });
    run.mockResolvedValueOnce({ outcome: "FAILED", iterations: 1, chatMessagesSent: 0 });

    await service.handle(chatEnvelope("BlueBeeBot, task 1"), "d-1");
    advance(30_000);
    await service.handle(chatEnvelope("BlueBeeBot, task 2"), "d-2");
    advance(30_000);
    await service.handle(chatEnvelope("BlueBeeBot, task 3"), "d-3");
    expect(sentMessages(recallClient)).toEqual([
      "Sorry, I could not complete that.",
      "Command limit reached for this meeting.",
    ]);

    expect(run.mock.calls[1][0].recentLines.map((line) => line.source)).toEqual(["CHAT"]);
    expect(appendLine.mock.calls.map(([, line]) => line.source)).toEqual(["CHAT", "CHAT", "CHAT"]);
    appendLine.mockRestore();
  });

  it("passes more than twenty earlier lines to the agent", async () => {
    const { service, run } = setup();

    for (let index = 1; index <= 30; index++) {
      await service.handle(chatEnvelope(`Line ${index}`), `d-${index}`);
    }
    await service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-31");

    expect(run.mock.calls[0][0].recentLines.map((line) => line.text)).toEqual(
      Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`)
    );
  });

  it("warns once without the text when an ignored utterance looks like a misheard name", async () => {
    const { service, run, logger } = setup();
    const text = "Blue Bird Bot, summarise the budget";

    await expect(service.handle(speechEnvelope(text), null)).resolves.toBe("BUFFERED");

    expect(run).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Meeting agent ignored a possible mention", {
      botId: BOT_ID,
      sessionId: SESSION_ID,
      kind: "SPEECH",
      length: text.length,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("budget");
  });

  it("logs nothing for an ordinary line without a trigger", async () => {
    const { service, logger } = setup();

    await expect(service.handle(chatEnvelope("Hello team"), "d-1")).resolves.toBe("BUFFERED");

    for (const fn of [logger.debug, logger.error, logger.info, logger.warn]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("warns without the text when a command is dropped as a duplicate", async () => {
    const { service, logger } = setup();

    await service.handle(chatEnvelope("BlueBeeBot, summarise the budget"), "d-1");
    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise the budget"), "d-2")).resolves.toBe(
      "DUPLICATE"
    );

    expect(logger.warn).toHaveBeenCalledWith("Meeting agent dropped a duplicate command", {
      botId: BOT_ID,
      sessionId: SESSION_ID,
      kind: "CHAT",
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("budget");
  });

  it("warns without the text when a command is rate limited", async () => {
    const { service, logger } = setup({ maxCommandsPerMeeting: 1 });

    await service.handle(chatEnvelope("BlueBeeBot, task one"), "d-1");
    await expect(service.handle(chatEnvelope("BlueBeeBot, summarise the budget"), "d-2")).resolves.toBe(
      "RATE_LIMITED"
    );

    expect(logger.warn).toHaveBeenCalledWith("Meeting agent command was rate limited", {
      botId: BOT_ID,
      sessionId: SESSION_ID,
      outcome: "MEETING_LIMIT",
      kind: "CHAT",
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("budget");
  });

  it("warns when an agent run ends without completing", async () => {
    const { service, run, logger } = setup();
    run.mockResolvedValueOnce({ outcome: "LOOP_LIMIT", iterations: 8, chatMessagesSent: 0 });

    await service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1");

    expect(logger.warn).toHaveBeenCalledWith("Meeting agent run", {
      botId: BOT_ID,
      sessionId: SESSION_ID,
      kind: "CHAT",
      outcome: "LOOP_LIMIT",
      iterations: 8,
      durationMs: 0,
      queuedMs: 0,
      acked: false,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("logs each run's duration and queue time at warn without the text", async () => {
    const { service, run, logger, advance } = setup();
    const first = createDeferred<MeetingAgentRunResult>();
    run.mockReturnValueOnce(first.promise).mockImplementationOnce(async () => {
      advance(1_500);
      return { outcome: "COMPLETED", iterations: 3, chatMessagesSent: 1 };
    });

    const firstHandle = service.handle(chatEnvelope("BlueBeeBot, summarise the budget"), "d-1");
    const secondHandle = service.handle(chatEnvelope("BlueBeeBot, list the actions", BOB), "d-2");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    advance(2_000);
    first.resolve(COMPLETED);
    await Promise.all([firstHandle, secondHandle]);

    expect(logger.warn).toHaveBeenNthCalledWith(1, "Meeting agent run", {
      botId: BOT_ID,
      sessionId: SESSION_ID,
      kind: "CHAT",
      outcome: "COMPLETED",
      iterations: 1,
      durationMs: 2_000,
      queuedMs: 0,
      acked: false,
    });
    expect(logger.warn).toHaveBeenNthCalledWith(2, "Meeting agent run", {
      botId: BOT_ID,
      sessionId: SESSION_ID,
      kind: "CHAT",
      outcome: "COMPLETED",
      iterations: 3,
      durationMs: 1_500,
      queuedMs: 2_000,
      acked: false,
    });
    expect(logger.info).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("budget");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("actions");
  });

  it("logs a thrown run as failed alongside its error kind", async () => {
    const { service, run, logger } = setup();
    run.mockRejectedValueOnce(new Error("model unavailable"));

    await service.handle(chatEnvelope("BlueBeeBot, summarise"), "d-1");

    expect(logger.warn).toHaveBeenCalledWith(
      "Meeting agent run",
      expect.objectContaining({ outcome: "FAILED", acked: false, queuedMs: 0, durationMs: 0 })
    );
    expect(
      logger.warn.mock.calls.find(([message]) => message === "Meeting agent run")?.[1]
    ).not.toHaveProperty("iterations");
  });

  describe("acknowledgement", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function replyAfter(run: ReturnType<typeof setup>["run"], gate: Promise<void>, reply: string) {
      run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
        await gate;
        await actions.sendChatMessage(reply);
        return COMPLETED;
      });
    }

    it("posts one short ack in chat when the run stays silent past the delay", async () => {
      vi.useFakeTimers();
      const { service, run, recallClient, synthesize, logger } = setup({ voice: true });
      const gate = createDeferred<void>();
      replyAfter(run, gate.promise, "Here is the answer");

      const handled = service.handle(speechEnvelope("BlueBeeBot, open the report"), null);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(sentMessages(recallClient)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sentMessages(recallClient)).toEqual(["On it…"]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sentMessages(recallClient)).toEqual(["On it…"]);

      gate.resolve();
      await expect(handled).resolves.toBe("HANDLED");
      expect(sentMessages(recallClient)).toEqual(["On it…", "Here is the answer"]);
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(synthesize).toHaveBeenCalledWith("Here is the answer");
      expect(logger.warn).toHaveBeenCalledWith("Meeting agent run", expect.objectContaining({ acked: true }));
    });

    it("acks in Polish when the command looks Polish", async () => {
      vi.useFakeTimers();
      const { service, run, recallClient } = setup();
      const gate = createDeferred<void>();
      replyAfter(run, gate.promise, "Gotowe");

      const handled = service.handle(
        chatEnvelope("BlueBeeBot, pokaz mi raport, prosze. Czy jest gotowy"),
        "d-1"
      );
      await vi.advanceTimersByTimeAsync(4_000);
      gate.resolve();
      await handled;

      expect(sentMessages(recallClient)).toEqual(["Już się tym zajmuję…", "Gotowe"]);
    });

    it("does not ack when the reply comes before the delay", async () => {
      vi.useFakeTimers();
      const { service, run, recallClient, logger } = setup();
      const gate = createDeferred<void>();
      const finish = createDeferred<MeetingAgentRunResult>();
      run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
        await gate.promise;
        await actions.sendChatMessage("Quick answer");
        return finish.promise;
      });

      const handled = service.handle(chatEnvelope("BlueBeeBot, open the report"), "d-1");
      await vi.advanceTimersByTimeAsync(1_000);
      gate.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      finish.resolve(COMPLETED);
      await handled;

      expect(sentMessages(recallClient)).toEqual(["Quick answer"]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Meeting agent run",
        expect.objectContaining({ acked: false })
      );
    });

    it("does not record the ack as an agent line and ignores its echo", async () => {
      vi.useFakeTimers();
      const { service, run, advance } = setup();
      const gate = createDeferred<void>();
      replyAfter(run, gate.promise, "Answer one");

      const handled = service.handle(chatEnvelope("BlueBeeBot, open the report"), "d-1");
      await vi.advanceTimersByTimeAsync(4_000);
      gate.resolve();
      await handled;

      advance(1_000);
      await expect(service.handle(chatEnvelope("On it…", BOB), "d-2")).resolves.toBe("IGNORED");
      advance(1_000);
      await service.handle(chatEnvelope("BlueBeeBot, second question", BOB), "d-3");

      expect(run.mock.calls[1][0].recentLines.map((line) => [line.source, line.text])).toEqual([
        ["CHAT", "BlueBeeBot, open the report"],
        ["AGENT", "Answer one"],
      ]);
    });

    it("acks a queued command as soon as its run starts when it waited longer than the delay", async () => {
      const { service, run, recallClient, advance, logger } = setup();
      const first = createDeferred<MeetingAgentRunResult>();
      run.mockReturnValueOnce(first.promise).mockImplementationOnce(async () => {
        expect(sentMessages(recallClient)).toEqual(["Już się tym zajmuję…"]);
        return COMPLETED;
      });

      const firstHandle = service.handle(chatEnvelope("BlueBeeBot, task one"), "d-1");
      const secondHandle = service.handle(chatEnvelope("BlueBeeBot, pokaż agendę", BOB), "d-2");
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      advance(5_000);
      first.resolve(COMPLETED);
      await Promise.all([firstHandle, secondHandle]);

      expect(run).toHaveBeenCalledTimes(2);
      expect(sentMessages(recallClient)).toEqual(["Już się tym zajmuję…"]);
      expect(logger.warn).toHaveBeenLastCalledWith(
        "Meeting agent run",
        expect.objectContaining({ queuedMs: 5_000, acked: true })
      );
    });

    it("does not ack a queued command that waited less than the delay", async () => {
      const { service, run, recallClient, advance } = setup();
      const first = createDeferred<MeetingAgentRunResult>();
      run.mockReturnValueOnce(first.promise);

      const firstHandle = service.handle(chatEnvelope("BlueBeeBot, task one"), "d-1");
      const secondHandle = service.handle(chatEnvelope("BlueBeeBot, task two", BOB), "d-2");
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      advance(3_000);
      first.resolve(COMPLETED);
      await Promise.all([firstHandle, secondHandle]);

      expect(sentMessages(recallClient)).toEqual([]);
    });
  });

  it("never logs the message text", async () => {
    const { service, run, logger } = setup({ maxCommandsPerMeeting: 2 });
    const secret = "read the confidential salary numbers";
    run
      .mockResolvedValueOnce({ outcome: "FAILED", iterations: 1, chatMessagesSent: 0 })
      .mockRejectedValueOnce(new Error(secret));

    await service.handle(chatEnvelope("Hello team"), "d-1");
    await service.handle(chatEnvelope(`BlueBeeBot, ${secret}`), "d-2");
    await service.handle(speechEnvelope(`BlueBeeBot, ${secret} now`), "d-3");
    await expect(service.handle(chatEnvelope(`BlueBeeBot, ${secret} again`), "d-4")).resolves.toBe(
      "RATE_LIMITED"
    );
    expect(run).toHaveBeenCalledTimes(2);

    const logged = [logger.debug, logger.error, logger.info, logger.warn].flatMap((fn) =>
      fn.mock.calls.map((args) => JSON.stringify(args))
    );
    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) {
      expect(entry).not.toContain("confidential salary");
      expect(entry).not.toContain("Hello team");
    }
  });

  describe("spoken replies", () => {
    function replyWith(run: ReturnType<typeof setup>["run"], ...replies: string[]) {
      run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
        for (const reply of replies) await actions.sendChatMessage(reply);
        return COMPLETED;
      });
    }

    it("speaks the reply to a spoken command after posting it to chat", async () => {
      const { service, run, recallClient, synthesize } = setup({ voice: true });
      replyWith(run, "BlueBeeBot: The agenda is here https://example.com/agenda");

      await expect(service.handle(speechEnvelope("BlueBeeBot, show the agenda"), null)).resolves.toBe(
        "HANDLED"
      );

      expect(sentMessages(recallClient)).toEqual(["The agenda is here https://example.com/agenda"]);
      expect(synthesize).toHaveBeenCalledWith("The agenda is here");
      expect(recallClient.outputAudio).toHaveBeenCalledWith(BOT_ID, "QUJD");
      expect(recallClient.sendChatMessage.mock.invocationCallOrder[0]).toBeLessThan(
        recallClient.outputAudio.mock.invocationCallOrder[0]
      );
    });

    it("does not speak the reply to a chat command", async () => {
      const { service, run, recallClient, synthesize } = setup({ voice: true });
      replyWith(run, "Answer");

      await service.handle(chatEnvelope("BlueBeeBot, question"), "d-1");

      expect(sentMessages(recallClient)).toEqual(["Answer"]);
      expect(synthesize).not.toHaveBeenCalled();
      expect(recallClient.outputAudio).not.toHaveBeenCalled();
    });

    it("replies in chat only when no speech synthesizer is configured", async () => {
      const { service, run, recallClient, synthesize } = setup();
      replyWith(run, "Answer");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      expect(sentMessages(recallClient)).toEqual(["Answer"]);
      expect(synthesize).not.toHaveBeenCalled();
      expect(recallClient.outputAudio).not.toHaveBeenCalled();
    });

    it("keeps the chat reply and the agent line when synthesis fails", async () => {
      const { service, run, recallClient, synthesize, logger, advance } = setup({ voice: true });
      synthesize.mockRejectedValueOnce(createSpeechSynthesisError("HTTP", "failed", 500));
      replyWith(run, "Secret answer one");

      await expect(service.handle(speechEnvelope("BlueBeeBot, first question"), null)).resolves.toBe(
        "HANDLED"
      );
      advance(1_000);
      await service.handle(chatEnvelope("BlueBeeBot, second question"), "d-2");

      expect(sentMessages(recallClient)).toEqual(["Secret answer one"]);
      expect(recallClient.outputAudio).not.toHaveBeenCalled();
      expect(run.mock.calls[1][0].recentLines.map((line) => line.source)).toEqual(["SPEECH", "AGENT"]);
      expect(logger.warn).toHaveBeenCalledWith("Failed to speak a meeting agent reply", {
        botId: BOT_ID,
        sessionId: SESSION_ID,
        kind: "HTTP",
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Secret answer");
    });

    it("keeps the chat reply when Recall rejects the audio", async () => {
      const { service, run, recallClient, logger } = setup({ voice: true });
      recallClient.outputAudio.mockRejectedValueOnce(new Error("audio unavailable"));
      replyWith(run, "Answer");

      await expect(service.handle(speechEnvelope("BlueBeeBot, question"), null)).resolves.toBe("HANDLED");

      expect(sentMessages(recallClient)).toEqual(["Answer"]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Failed to speak a meeting agent reply",
        expect.objectContaining({ kind: "UNKNOWN" })
      );
      expect(logger.warn).not.toHaveBeenCalledWith("Meeting agent run failed", expect.anything());
    });

    it("waits for the previous clip to finish before playing the next one", async () => {
      const { service, run, recallClient, sleep } = setup({ voice: true });
      replyWith(run, "First part", "Second part");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      expect(recallClient.outputAudio).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(SPEECH.durationMs);
      expect(sleep.mock.invocationCallOrder[0]).toBeLessThan(
        recallClient.outputAudio.mock.invocationCallOrder[1]
      );
    });

    it("caps the wait for the previous clip", async () => {
      const { service, run, synthesize, sleep } = setup({ voice: true });
      synthesize.mockResolvedValueOnce({ ...SPEECH, durationMs: 120_000 });
      replyWith(run, "Long part", "Next part");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      expect(sleep).toHaveBeenCalledWith(MAX_SPEECH_WAIT_MS);
    });

    it("does not wait once the previous clip has finished", async () => {
      const { service, run, sleep, advance, recallClient } = setup({ voice: true });
      replyWith(run, "Answer one");
      replyWith(run, "Answer two");

      await service.handle(speechEnvelope("BlueBeeBot, first question"), null);
      advance(SPEECH.durationMs);
      await service.handle(speechEnvelope("BlueBeeBot, second question"), null);

      expect(recallClient.outputAudio).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("does not speak a reply that is only a link", async () => {
      const { service, run, recallClient, synthesize } = setup({ voice: true });
      replyWith(run, "https://example.com/agenda");

      await service.handle(speechEnvelope("BlueBeeBot, link please"), null);

      expect(sentMessages(recallClient)).toEqual(["https://example.com/agenda"]);
      expect(synthesize).not.toHaveBeenCalled();
      expect(recallClient.outputAudio).not.toHaveBeenCalled();
    });

    it("does not speak the failure notice", async () => {
      const { service, run, recallClient, synthesize } = setup({ voice: true });
      run.mockResolvedValueOnce({ outcome: "FAILED", iterations: 1, chatMessagesSent: 0 });

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      expect(sentMessages(recallClient)).toEqual(["Sorry, I could not complete that."]);
      expect(synthesize).not.toHaveBeenCalled();
    });
  });

  describe("interrupting a spoken reply", () => {
    function replyWith(run: ReturnType<typeof setup>["run"], ...replies: string[]) {
      run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
        for (const reply of replies) await actions.sendChatMessage(reply);
        return COMPLETED;
      });
    }

    // Replies twice with a pause in between, so the run is still in progress while the test sends speech_on.
    function replyTwiceWithGate(run: ReturnType<typeof setup>["run"]) {
      const gate = createDeferred<void>();
      const firstReplySent = createDeferred<void>();
      run.mockImplementationOnce(async (_request, actions: MeetingAgentActions) => {
        await actions.sendChatMessage("Answer one");
        firstReplySent.resolve();
        await gate.promise;
        await actions.sendChatMessage("Answer two");
        return COMPLETED;
      });
      return { gate, firstReplySent };
    }

    it("stops the clip when the issuer starts talking after the run has finished", async () => {
      const { service, run, recallClient, logger, advance } = setup({ voice: true });
      replyWith(run, "Secret answer");

      await expect(service.handle(speechEnvelope("BlueBeeBot, secret question"), null)).resolves.toBe(
        "HANDLED"
      );
      advance(1_000);

      await expect(service.handle(speechOnEnvelope(ALICE), "d-on")).resolves.toBe("INTERRUPTED");
      expect(recallClient.stopOutputAudio).toHaveBeenCalledWith(BOT_ID);
      expect(logger.warn).toHaveBeenCalledWith("Meeting agent speech interrupted", {
        botId: BOT_ID,
        sessionId: SESSION_ID,
        signal: "speech_on",
        msIntoClip: 1_000,
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("ecret");
    });

    it("stops the clip when a partial transcript from the issuer arrives while it plays", async () => {
      const { service, run, recallClient, logger, advance } = setup({ voice: true });
      replyWith(run, "Answer");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);
      advance(500);

      await expect(service.handle(partialEnvelope("wait stop"), "d-p1")).resolves.toBe("INTERRUPTED");
      expect(recallClient.stopOutputAudio).toHaveBeenCalledWith(BOT_ID);
      expect(logger.warn).toHaveBeenCalledWith("Meeting agent speech interrupted", {
        botId: BOT_ID,
        sessionId: SESSION_ID,
        signal: "partial",
        msIntoClip: 500,
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("stop");
    });

    it("ignores a partial transcript without words", async () => {
      const { service, run, recallClient } = setup({ voice: true });
      replyWith(run, "Answer");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      await expect(service.handle(partialEnvelope(""), null)).resolves.toBe("IGNORED");
      expect(recallClient.stopOutputAudio).not.toHaveBeenCalled();
    });

    it("still plays the clip when the issuer talks before it starts", async () => {
      const { service, run, recallClient, synthesize, logger } = setup({ voice: true });
      const synthesis = createDeferred<SynthesizedSpeech>();
      synthesize.mockReturnValueOnce(synthesis.promise);
      replyWith(run, "Answer");

      const commandHandle = service.handle(speechEnvelope("BlueBeeBot, question"), null);
      await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));

      await expect(service.handle(speechOnEnvelope(ALICE), null)).resolves.toBe("IGNORED");
      await expect(service.handle(partialEnvelope("and also"), null)).resolves.toBe("IGNORED");

      synthesis.resolve(SPEECH);
      await expect(commandHandle).resolves.toBe("HANDLED");
      expect(recallClient.outputAudio).toHaveBeenCalledTimes(1);
      expect(recallClient.stopOutputAudio).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith("Meeting agent speech interrupted", expect.anything());
    });

    it("ignores another participant talking while the clip plays", async () => {
      const { service, run, recallClient } = setup({ voice: true });
      replyWith(run, "Answer");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      await expect(service.handle(speechOnEnvelope(BOB), null)).resolves.toBe("IGNORED");
      await expect(service.handle(partialEnvelope("hello", BOB), null)).resolves.toBe("IGNORED");
      expect(recallClient.stopOutputAudio).not.toHaveBeenCalled();
    });

    it("ignores the issuer talking once the clip has ended", async () => {
      const { service, run, recallClient, advance } = setup({ voice: true });
      replyWith(run, "Answer");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);
      advance(SPEECH.durationMs);

      await expect(service.handle(speechOnEnvelope(ALICE), null)).resolves.toBe("IGNORED");
      await expect(service.handle(partialEnvelope("hello"), null)).resolves.toBe("IGNORED");
      expect(recallClient.stopOutputAudio).not.toHaveBeenCalled();
    });

    it("ignores speech_on when nothing has been spoken", async () => {
      const { service, recallClient } = setup({ voice: true });

      await expect(service.handle(speechOnEnvelope(ALICE), null)).resolves.toBe("IGNORED");
      expect(recallClient.stopOutputAudio).not.toHaveBeenCalled();
    });

    it("skips the remaining clips of an interrupted run but keeps its chat replies", async () => {
      const { service, run, recallClient } = setup({ voice: true });
      const { gate, firstReplySent } = replyTwiceWithGate(run);

      const commandHandle = service.handle(speechEnvelope("BlueBeeBot, question"), null);
      await firstReplySent.promise;
      expect(recallClient.outputAudio).toHaveBeenCalledTimes(1);

      await expect(service.handle(speechOnEnvelope(ALICE), null)).resolves.toBe("INTERRUPTED");

      gate.resolve();
      await expect(commandHandle).resolves.toBe("HANDLED");
      expect(sentMessages(recallClient)).toEqual(["Answer one", "Answer two"]);
      expect(recallClient.outputAudio).toHaveBeenCalledTimes(1);
    });

    it("speaks the next run's reply after an interrupted run", async () => {
      const { service, run, recallClient, advance, sleep } = setup({ voice: true });
      replyWith(run, "Answer one");
      replyWith(run, "Answer two");

      await service.handle(speechEnvelope("BlueBeeBot, first question"), null);
      await service.handle(speechOnEnvelope(ALICE), null);
      advance(1_000);
      await service.handle(speechEnvelope("BlueBeeBot, second question"), null);

      expect(recallClient.outputAudio).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("stops a clip only once however many signals follow", async () => {
      const { service, run, recallClient } = setup({ voice: true });
      const stop = createDeferred<"OK">();
      recallClient.stopOutputAudio.mockReturnValueOnce(stop.promise);
      replyWith(run, "Answer");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      const firstStop = service.handle(speechOnEnvelope(ALICE), "d-1");
      await expect(service.handle(partialEnvelope("stop"), "d-2")).resolves.toBe("IGNORED");
      stop.resolve("OK");
      await expect(firstStop).resolves.toBe("INTERRUPTED");
      await expect(service.handle(partialEnvelope("stop please"), "d-3")).resolves.toBe("IGNORED");
      expect(recallClient.stopOutputAudio).toHaveBeenCalledTimes(1);
    });

    it("ignores speech_on during a chat command's run", async () => {
      const { service, run, recallClient } = setup({ voice: true });
      const { gate, firstReplySent } = replyTwiceWithGate(run);

      const commandHandle = service.handle(chatEnvelope("BlueBeeBot, question"), "d-1");
      await firstReplySent.promise;

      await expect(service.handle(speechOnEnvelope(ALICE), "d-2")).resolves.toBe("IGNORED");
      gate.resolve();
      await commandHandle;
      expect(recallClient.stopOutputAudio).not.toHaveBeenCalled();
    });

    it("never records speech_on or a partial transcript as a line or treats it as a command", async () => {
      const { service, run } = setup({ voice: true });

      await expect(service.handle(speechOnEnvelope(ALICE), "d-1")).resolves.toBe("IGNORED");
      await expect(service.handle(partialEnvelope("BlueBeeBot, open the agenda"), "d-2")).resolves.toBe(
        "IGNORED"
      );
      await expect(service.handle(partialEnvelope("BlueBeeBot"), "d-3")).resolves.toBe("IGNORED");
      expect(run).not.toHaveBeenCalled();

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0].command).toBe("question");
      expect(run.mock.calls[0][0].recentLines).toEqual([]);
    });

    it("reports a repeated speech_on delivery as a duplicate", async () => {
      const { service, run, recallClient } = setup({ voice: true });
      replyWith(run, "Answer");

      await service.handle(speechEnvelope("BlueBeeBot, question"), null);

      await expect(service.handle(speechOnEnvelope(ALICE), "d-on")).resolves.toBe("INTERRUPTED");
      await expect(service.handle(speechOnEnvelope(ALICE), "d-on")).resolves.toBe("DUPLICATE");
      expect(recallClient.stopOutputAudio).toHaveBeenCalledTimes(1);
    });

    it("still interrupts when Recall rejects the stop request", async () => {
      const { service, run, recallClient, logger } = setup({ voice: true });
      recallClient.stopOutputAudio.mockRejectedValueOnce(new Error("stop failed"));
      const { gate, firstReplySent } = replyTwiceWithGate(run);

      const commandHandle = service.handle(speechEnvelope("BlueBeeBot, question"), null);
      await firstReplySent.promise;

      await expect(service.handle(speechOnEnvelope(ALICE), null)).resolves.toBe("INTERRUPTED");
      expect(logger.warn).toHaveBeenCalledWith("Failed to stop meeting agent speech", {
        botId: BOT_ID,
        sessionId: SESSION_ID,
        kind: "UNKNOWN",
      });

      gate.resolve();
      await expect(commandHandle).resolves.toBe("HANDLED");
      expect(recallClient.outputAudio).toHaveBeenCalledTimes(1);
    });
  });
});
