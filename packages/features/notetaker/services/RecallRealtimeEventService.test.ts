import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { describe, expect, it, vi } from "vitest";
import type { IMeetingAgent, MeetingAgentActions, MeetingAgentRunResult } from "../agent/IMeetingAgent";
import { MeetingAgentStateStore } from "../agent/MeetingAgentStateStore";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import type { RecallRealtimeEnvelope } from "../bot/recall/recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "../bot/recall/recallSchemas";
import { getNotetakerConfig } from "../lib/config";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { RecallRealtimeEventService } from "./RecallRealtimeEventService";

const BOT_ID = "bot-1";
const SESSION_ID = "session-1";
const DISPLAY_NAME = "BlueBee Notetaker";
const START = new Date("2026-11-20T10:00:00.000Z");
const ALICE = { id: 1, name: "Alice" };
const BOB = { id: 2, name: "Bob" };

const COMPLETED: MeetingAgentRunResult = { outcome: "COMPLETED", iterations: 1, chatMessagesSent: 0 };

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

function createFakeRecallClient() {
  return {
    createBot: vi.fn<IRecallApiClient["createBot"]>(),
    retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>(),
    listBotsByMetadata: vi.fn<IRecallApiClient["listBotsByMetadata"]>(),
    leaveCall: vi.fn<IRecallApiClient["leaveCall"]>(),
    deleteScheduledBot: vi.fn<IRecallApiClient["deleteScheduledBot"]>(),
    sendChatMessage: vi.fn<IRecallApiClient["sendChatMessage"]>().mockResolvedValue(undefined),
    outputAudio: vi.fn<IRecallApiClient["outputAudio"]>().mockResolvedValue(undefined),
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

  const service = new RecallRealtimeEventService(
    {
      recallClient,
      sessionRepository: repositories.sessionRepository,
      meetingAgent: options.agentEnabled === false ? null : meetingAgent,
      config,
      logger,
    },
    { store: new MeetingAgentStateStore(), now: () => current }
  );

  return { service, recallClient, logger, run, advance };
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
});
