import logger from "@calcom/lib/logger";
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { notetakerBotJoinRequestSchema } from "@calcom/lib/notetaker/botContract";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotetakerAgentSpeechProvider, NotetakerConfig } from "../../lib/config";
import { getNotetakerConfig } from "../../lib/config";
import { getNotetakerBotGatewayFailure } from "../INotetakerBotGateway";
import type { IRecallApiClient } from "./RecallApiClient";
import { createRecallApiError } from "./RecallApiClient";
import type { RecallMeetingAgentOptions } from "./RecallBotGateway";
import {
  buildRecallAutomaticAudioOutput,
  buildRecallCreateBotRequest,
  buildRecallRecordingConfig,
  getRecallMeetingAgentOptions,
  RECALL_WEB_4_CORE_VARIANT,
  RecallBotGateway,
} from "./RecallBotGateway";
import type { RecallBot } from "./recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "./recallSchemas";
import { RECALL_SILENT_MP3_BASE64 } from "./silentMp3";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const BOT_ID = "bot-1";
const NOW = new Date("2030-01-01T10:00:00.000Z");

function buildJoinRequest(overrides: Partial<NotetakerBotJoinRequest> = {}): NotetakerBotJoinRequest {
  return notetakerBotJoinRequestSchema.parse({
    sessionId: SESSION_ID,
    platform: "GOOGLE_MEET",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "Example Notetaker for Jane Host",
    noticeMessage: "This meeting is being transcribed by an automated notetaker.",
    scheduledStartAt: "2030-01-01T10:15:00.000Z",
    callbackUrl: "https://app.example.test/api/notetaker/events",
    limits: {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 900,
      aloneTimeoutSeconds: 120,
      maxDurationSeconds: 14400,
    },
    ...overrides,
  });
}

function buildBot(codes: string[] = [], id = BOT_ID): RecallBot {
  return {
    id,
    status_changes: codes.map((code, index) => ({
      code,
      sub_code: null,
      created_at: new Date(NOW.getTime() + index * 1000).toISOString(),
    })),
    recordings: [],
    metadata: { [RECALL_SESSION_METADATA_KEY]: SESSION_ID },
  };
}

type FakeRecallClient = { [K in keyof IRecallApiClient]: Mock<IRecallApiClient[K]> };

function createFakeClient(overrides: Partial<FakeRecallClient> = {}): FakeRecallClient {
  return {
    createBot: vi.fn<IRecallApiClient["createBot"]>().mockResolvedValue(buildBot()),
    retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>().mockResolvedValue(null),
    listBotsByMetadata: vi.fn<IRecallApiClient["listBotsByMetadata"]>().mockResolvedValue([]),
    leaveCall: vi.fn<IRecallApiClient["leaveCall"]>().mockResolvedValue("OK"),
    deleteScheduledBot: vi.fn<IRecallApiClient["deleteScheduledBot"]>().mockResolvedValue("OK"),
    createTranscript: vi.fn<IRecallApiClient["createTranscript"]>().mockResolvedValue({ id: "t-1" }),
    retrieveTranscript: vi.fn<IRecallApiClient["retrieveTranscript"]>().mockResolvedValue(null),
    downloadTranscript: vi.fn<IRecallApiClient["downloadTranscript"]>().mockResolvedValue([]),
    listTranscriptsByRecording: vi.fn<IRecallApiClient["listTranscriptsByRecording"]>().mockResolvedValue([]),
    sendChatMessage: vi.fn<IRecallApiClient["sendChatMessage"]>().mockResolvedValue(undefined),
    outputAudio: vi.fn<IRecallApiClient["outputAudio"]>().mockResolvedValue(undefined),
    startScreenshare: vi.fn<IRecallApiClient["startScreenshare"]>().mockResolvedValue(undefined),
    stopScreenshare: vi.fn<IRecallApiClient["stopScreenshare"]>().mockResolvedValue("OK"),
    ...overrides,
  };
}

function createGateway(input: {
  client: IRecallApiClient;
  externalRef?: string | null;
  agent?: RecallMeetingAgentOptions | null;
}): RecallBotGateway {
  const externalRef = input.externalRef === undefined ? BOT_ID : input.externalRef;
  return new RecallBotGateway({
    client: input.client,
    findExternalRef: async () => externalRef,
    now: () => NOW,
    agent: input.agent,
  });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

const AVATAR = { kind: "jpeg", base64: "QUJD" } as const;
const REALTIME_URL = "https://app.example.com/api/notetaker/recall/realtime";

function buildAgent(
  speechProvider: NotetakerAgentSpeechProvider = "DEEPGRAM",
  voice = false,
  keyterms = false
): RecallMeetingAgentOptions {
  return { realtimeUrl: REALTIME_URL, speechProvider, voice, keyterms };
}

function badRequest(fieldNames: string[]) {
  return createRecallApiError("BAD_REQUEST", "bad", { status: 400, fieldNames });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildRecallCreateBotRequest avatar", () => {
  it("sends the same image for both call states", () => {
    const body = buildRecallCreateBotRequest(buildJoinRequest(), NOW, AVATAR);
    expect(body.automatic_video_output).toEqual({
      in_call_recording: { kind: "jpeg", b64_data: "QUJD" },
      in_call_not_recording: { kind: "jpeg", b64_data: "QUJD" },
    });
  });

  it("omits automatic_video_output without an avatar", () => {
    expect("automatic_video_output" in buildRecallCreateBotRequest(buildJoinRequest(), NOW)).toBe(false);
    expect("automatic_video_output" in buildRecallCreateBotRequest(buildJoinRequest(), NOW, null)).toBe(
      false
    );
  });
});

describe("RecallBotGateway avatar fallback", () => {
  it("retries once without the image when Recall rejects automatic_video_output", async () => {
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_video_output"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await expect(
      createGateway({ client }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    ).resolves.toEqual({ externalRef: "bot-2" });

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[0][0].automatic_video_output).toBeDefined();
    expect(client.createBot.mock.calls[1][0].automatic_video_output).toBeUndefined();
  });

  it("maps a 400 on the retry to LINK_UNUSABLE", async () => {
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_video_output"]))
      .mockRejectedValueOnce(badRequest(["meeting_url"]));

    const error = await captureError(
      createGateway({ client }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400 on the meeting url", async () => {
    const client = createFakeClient();
    client.createBot.mockRejectedValue(badRequest(["meeting_url"]));

    const error = await captureError(
      createGateway({ client }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(1);
  });

  it("does not retry without an avatar", async () => {
    const client = createFakeClient();
    client.createBot.mockRejectedValue(badRequest(["automatic_video_output"]));

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(1);
  });
});

describe("buildRecallCreateBotRequest", () => {
  it("maps the join request onto the Recall create bot body", () => {
    expect(buildRecallCreateBotRequest(buildJoinRequest(), NOW)).toEqual({
      meeting_url: "https://meet.google.com/abc-defg-hij",
      bot_name: "Example Notetaker for Jane Host",
      join_at: "2030-01-01T10:15:00.000Z",
      metadata: { notetakerSessionId: SESSION_ID },
      chat: {
        on_bot_join: {
          send_to: "everyone",
          message: "This meeting is being transcribed by an automated notetaker.",
          pin: true,
        },
      },
      automatic_leave: {
        waiting_room_timeout: 600,
        noone_joined_timeout: 900,
        everyone_left_timeout: { timeout: 120 },
        in_call_recording_timeout: 14400,
      },
    });
  });

  it("omits join_at so Recall joins immediately when the scheduled start is already in the past", () => {
    const body = buildRecallCreateBotRequest(
      buildJoinRequest({ scheduledStartAt: "2030-01-01T09:00:00.000Z" }),
      NOW
    );
    expect(body).not.toHaveProperty("join_at");
  });

  it("omits join_at when the scheduled start is within the immediate-join margin", () => {
    const body = buildRecallCreateBotRequest(
      buildJoinRequest({ scheduledStartAt: "2030-01-01T10:00:30.000Z" }),
      NOW
    );
    expect(body).not.toHaveProperty("join_at");
  });

  it("keeps the exact join_at when the scheduled start is beyond the margin", () => {
    const body = buildRecallCreateBotRequest(
      buildJoinRequest({ scheduledStartAt: "2030-01-01T10:01:01.000Z" }),
      NOW
    );
    expect(body.join_at).toBe("2030-01-01T10:01:01.000Z");
  });

  it("truncates the bot name and the chat notice to Recall's limits", () => {
    const body = buildRecallCreateBotRequest(
      buildJoinRequest({ displayName: "n".repeat(150), noticeMessage: "m".repeat(700) }),
      NOW
    );
    expect(body.bot_name).toHaveLength(100);
    expect(body.chat.on_bot_join.message).toHaveLength(500);
  });

  it("leaves recording_config out so Recall records by default", () => {
    expect(buildRecallCreateBotRequest(buildJoinRequest(), NOW)).not.toHaveProperty("recording_config");
  });

  it("sends the alone timeout without activate_after, which Recall rejects at 0", () => {
    const everyoneLeft = buildRecallCreateBotRequest(buildJoinRequest(), NOW).automatic_leave
      .everyone_left_timeout;
    expect(everyoneLeft).toStrictEqual({ timeout: 120 });
    expect(everyoneLeft).not.toHaveProperty("activate_after");
  });
});

describe("RecallBotGateway.requestJoin", () => {
  it("returns the created bot id as the external ref", async () => {
    const client = createFakeClient({
      createBot: vi.fn<IRecallApiClient["createBot"]>().mockResolvedValue(buildBot([], "bot-new")),
    });
    const gateway = createGateway({ client });

    await expect(gateway.requestJoin(buildJoinRequest())).resolves.toEqual({ externalRef: "bot-new" });
    expect(client.createBot).toHaveBeenCalledWith(buildRecallCreateBotRequest(buildJoinRequest(), NOW));
  });

  it("reports LINK_UNUSABLE when Recall rejects the meeting URL", async () => {
    const client = createFakeClient({
      createBot: vi
        .fn<IRecallApiClient["createBot"]>()
        .mockRejectedValue(
          createRecallApiError("BAD_REQUEST", "bad", { status: 400, fieldNames: ["meeting_url"] })
        ),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect((error as Error).message).toContain("Recall rejected the meeting URL (status 400)");
  });

  it("reports LINK_UNUSABLE for any bad request so the sweep does not retry it", async () => {
    const client = createFakeClient({
      createBot: vi
        .fn<IRecallApiClient["createBot"]>()
        .mockRejectedValue(
          createRecallApiError("BAD_REQUEST", "bad", { status: 400, fieldNames: ["join_at"] })
        ),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect((error as Error).message).toContain("fields: join_at");
    expect(client.listBotsByMetadata).not.toHaveBeenCalled();
  });

  it("reports LINK_UNUSABLE for a bad request that names no fields", async () => {
    const client = createFakeClient({
      createBot: vi
        .fn<IRecallApiClient["createBot"]>()
        .mockRejectedValue(createRecallApiError("BAD_REQUEST", "bad", { status: 400, fieldNames: [] })),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect((error as Error).message).toContain("fields: none");
  });

  it("keeps the meeting URL out of the bad request error message", async () => {
    const client = createFakeClient({
      createBot: vi
        .fn<IRecallApiClient["createBot"]>()
        .mockRejectedValue(
          createRecallApiError("BAD_REQUEST", "bad", { status: 400, fieldNames: ["meeting_url"] })
        ),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect((error as Error).message).not.toContain(buildJoinRequest().meetingUrl);
  });

  it("reports TRANSIENT for a non-400 HTTP failure so only BAD_REQUEST is permanent", async () => {
    const client = createFakeClient({
      createBot: vi
        .fn<IRecallApiClient["createBot"]>()
        .mockRejectedValue(createRecallApiError("HTTP", "unprocessable", { status: 422 })),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    expect(client.listBotsByMetadata).not.toHaveBeenCalled();
  });

  it.each(["NETWORK", "TIMEOUT"] as const)("reuses a bot created despite a %s failure", async (kind) => {
    const client = createFakeClient({
      createBot: vi.fn<IRecallApiClient["createBot"]>().mockRejectedValue(createRecallApiError(kind, "lost")),
      listBotsByMetadata: vi
        .fn<IRecallApiClient["listBotsByMetadata"]>()
        .mockResolvedValue([buildBot([], "bot-found")]),
    });

    await expect(createGateway({ client }).requestJoin(buildJoinRequest())).resolves.toEqual({
      externalRef: "bot-found",
    });
    expect(client.listBotsByMetadata).toHaveBeenCalledWith(RECALL_SESSION_METADATA_KEY, SESSION_ID);
  });

  it("reports TRANSIENT when a timed-out create left no bot behind", async () => {
    const client = createFakeClient({
      createBot: vi
        .fn<IRecallApiClient["createBot"]>()
        .mockRejectedValue(createRecallApiError("TIMEOUT", "lost")),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
  });

  it("reports TRANSIENT when reconciling after a network failure also fails", async () => {
    const client = createFakeClient({
      createBot: vi
        .fn<IRecallApiClient["createBot"]>()
        .mockRejectedValue(createRecallApiError("NETWORK", "lost")),
      listBotsByMetadata: vi
        .fn<IRecallApiClient["listBotsByMetadata"]>()
        .mockRejectedValue(createRecallApiError("NETWORK", "lost")),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
  });

  it.each([
    "RATE_LIMITED",
    "UNAVAILABLE",
    "HTTP",
    "INVALID_RESPONSE",
  ] as const)("reports TRANSIENT for %s without reconciling", async (kind) => {
    const client = createFakeClient({
      createBot: vi.fn<IRecallApiClient["createBot"]>().mockRejectedValue(createRecallApiError(kind, "x")),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    expect(client.listBotsByMetadata).not.toHaveBeenCalled();
  });

  it("reports TRANSIENT for an unexpected error", async () => {
    const client = createFakeClient({
      createBot: vi.fn<IRecallApiClient["createBot"]>().mockRejectedValue(new Error("boom")),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
  });
});

describe("buildRecallRecordingConfig", () => {
  it("streams Deepgram transcripts and chat messages to the realtime endpoint", () => {
    expect(buildRecallRecordingConfig(buildAgent("DEEPGRAM", false, true))).toStrictEqual({
      transcript: {
        provider: {
          deepgram_streaming: {
            model: "nova-3",
            language: "multi",
            mip_opt_out: true,
            keyterm: ["BlueBeeBot"],
          },
        },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: REALTIME_URL,
          events: ["participant_events.chat_message", "transcript.data"],
        },
      ],
    });
  });

  it("leaves the keyterm prompt out once it was dropped", () => {
    expect(buildRecallRecordingConfig(buildAgent("DEEPGRAM", false, false)).transcript).toStrictEqual({
      provider: { deepgram_streaming: { model: "nova-3", language: "multi", mip_opt_out: true } },
    });
  });

  it("streams Recall's low-latency English transcripts and chat messages", () => {
    expect(buildRecallRecordingConfig(buildAgent("RECALLAI_EN", false, true))).toStrictEqual({
      transcript: {
        provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: REALTIME_URL,
          events: ["participant_events.chat_message", "transcript.data"],
        },
      ],
    });
  });

  it("streams only chat messages without a speech provider", () => {
    expect(buildRecallRecordingConfig(buildAgent("NONE"))).toStrictEqual({
      realtime_endpoints: [
        { type: "webhook", url: REALTIME_URL, events: ["participant_events.chat_message"] },
      ],
    });
  });
});

describe("buildRecallCreateBotRequest agent", () => {
  it("adds the recording config for the agent", () => {
    const body = buildRecallCreateBotRequest(buildJoinRequest(), NOW, null, buildAgent("DEEPGRAM"));
    expect(body.recording_config).toStrictEqual(buildRecallRecordingConfig(buildAgent("DEEPGRAM")));
  });

  it("leaves the rest of the body unchanged and adds no output media", () => {
    const plain = buildRecallCreateBotRequest(buildJoinRequest(), NOW);
    const withAgent = buildRecallCreateBotRequest(buildJoinRequest(), NOW, undefined, buildAgent());

    expect(withAgent.chat.on_bot_join).toStrictEqual(plain.chat.on_bot_join);
    expect(withAgent.automatic_leave).toStrictEqual(plain.automatic_leave);
    expect(withAgent.metadata).toStrictEqual(plain.metadata);
    expect(withAgent).not.toHaveProperty("variant");
    expect(withAgent).not.toHaveProperty("output_media");
    const { recording_config: _recordingConfig, ...rest } = withAgent;
    expect(rest).toStrictEqual(plain);
  });

  it("omits recording_config for a null agent", () => {
    expect(buildRecallCreateBotRequest(buildJoinRequest(), NOW, null, null)).not.toHaveProperty(
      "recording_config"
    );
  });
});

describe("RecallBotGateway agent fallback", () => {
  it("sends the recording config when the gateway has an agent", async () => {
    const client = createFakeClient();

    await createGateway({ client, agent: buildAgent() }).requestJoin(buildJoinRequest());

    expect(client.createBot).toHaveBeenCalledWith(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW, null, buildAgent())
    );
  });

  it("retries once without the recording config when Recall rejects it, so note-taking continues", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await expect(
      createGateway({ client, agent: buildAgent() }).requestJoin(buildJoinRequest())
    ).resolves.toEqual({ externalRef: "bot-2" });

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[0][0].recording_config).toBeDefined();
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("recording_config");
    expect(client.createBot.mock.calls[1][0]).toStrictEqual(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW)
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recording config"));
  });

  it("drops both the avatar and the recording config when Recall rejects both at once", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_video_output", "recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await expect(
      createGateway({ client, agent: buildAgent() }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    ).resolves.toEqual({ externalRef: "bot-2" });

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[0][0]).toHaveProperty("automatic_video_output");
    expect(client.createBot.mock.calls[0][0]).toHaveProperty("recording_config");
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("automatic_video_output");
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("recording_config");
  });

  it("does not retry a 400 that names neither optional part", async () => {
    const client = createFakeClient();
    client.createBot.mockRejectedValue(badRequest(["join_at"]));

    const error = await captureError(
      createGateway({ client, agent: buildAgent() }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(1);
  });

  it("maps a second 400 on recording_config after dropping it to LINK_UNUSABLE without looping", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot.mockRejectedValue(badRequest(["recording_config"]));

    const error = await captureError(
      createGateway({ client, agent: buildAgent() }).requestJoin(buildJoinRequest())
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(2);
  });

  it("retries again when each 400 drops a different part", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockRejectedValueOnce(badRequest(["automatic_video_output"]))
      .mockResolvedValueOnce(buildBot([], "bot-3"));

    await expect(
      createGateway({ client, agent: buildAgent() }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    ).resolves.toEqual({ externalRef: "bot-3" });

    expect(client.createBot).toHaveBeenCalledTimes(3);
    expect(client.createBot.mock.calls[2][0]).not.toHaveProperty("automatic_video_output");
    expect(client.createBot.mock.calls[2][0]).not.toHaveProperty("recording_config");
  });

  it("does not retry a recording_config 400 when the gateway has no agent", async () => {
    const client = createFakeClient();
    client.createBot.mockRejectedValue(badRequest(["recording_config"]));

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(1);
  });
});

describe("RecallBotGateway keyterm fallback", () => {
  const keytermAgent = buildAgent("DEEPGRAM", false, true);

  it("retries without the keyterm prompt but keeps the agent when Recall rejects the recording config", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await expect(
      createGateway({ client, agent: keytermAgent }).requestJoin(buildJoinRequest())
    ).resolves.toEqual({ externalRef: "bot-2" });

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[0][0].recording_config).toStrictEqual(
      buildRecallRecordingConfig(keytermAgent)
    );
    expect(client.createBot.mock.calls[1][0].recording_config).toStrictEqual(
      buildRecallRecordingConfig({ ...keytermAgent, keyterms: false })
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("keyterm"));
  });

  it("drops the keyterm prompt for a 400 that names a nested keyterm path", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["recording_config.transcript.provider.deepgram_streaming.keyterm"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await createGateway({ client, agent: keytermAgent }).requestJoin(buildJoinRequest());

    expect(client.createBot.mock.calls[1][0].recording_config).toStrictEqual(
      buildRecallRecordingConfig({ ...keytermAgent, keyterms: false })
    );
  });

  it("drops the whole agent when Recall still rejects the recording config without keyterms", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-3"));

    await expect(
      createGateway({ client, agent: keytermAgent }).requestJoin(buildJoinRequest())
    ).resolves.toEqual({ externalRef: "bot-3" });

    expect(client.createBot).toHaveBeenCalledTimes(3);
    expect(client.createBot.mock.calls[1][0]).toHaveProperty("recording_config");
    expect(client.createBot.mock.calls[2][0]).toStrictEqual(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW)
    );
  });

  it("drops the whole agent at once for a provider that sends no keyterm prompt", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await createGateway({ client, agent: buildAgent("RECALLAI_EN", false, true) }).requestJoin(
      buildJoinRequest()
    );

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("recording_config");
  });

  it("succeeds on the sixth call when each 400 drops a different part", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_video_output"]))
      .mockRejectedValueOnce(badRequest(["automatic_audio_output"]))
      .mockRejectedValueOnce(badRequest(["variant"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-6"));

    const agent = { ...buildAgent("DEEPGRAM", true, true), variant: RECALL_WEB_4_CORE_VARIANT };
    await expect(
      createGateway({ client, agent }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    ).resolves.toEqual({ externalRef: "bot-6" });

    expect(client.createBot).toHaveBeenCalledTimes(6);
    expect(client.createBot.mock.calls[5][0]).toStrictEqual(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW)
    );
  });
});

describe("buildRecallCreateBotRequest voice", () => {
  it("plays the silent clip on join so Recall accepts spoken replies later", () => {
    expect(buildRecallAutomaticAudioOutput()).toStrictEqual({
      in_call_recording: { data: { kind: "mp3", b64_data: RECALL_SILENT_MP3_BASE64 } },
    });
  });

  it("adds automatic_audio_output only when the agent has voice", () => {
    const withVoice = buildRecallCreateBotRequest(
      buildJoinRequest(),
      NOW,
      null,
      buildAgent("DEEPGRAM", true)
    );
    expect(withVoice.automatic_audio_output).toStrictEqual(buildRecallAutomaticAudioOutput());
    expect(withVoice.recording_config).toStrictEqual(
      buildRecallRecordingConfig(buildAgent("DEEPGRAM", true))
    );

    expect(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW, null, buildAgent("DEEPGRAM", false))
    ).not.toHaveProperty("automatic_audio_output");
    expect(buildRecallCreateBotRequest(buildJoinRequest(), NOW, null, null)).not.toHaveProperty(
      "automatic_audio_output"
    );
    expect(buildRecallCreateBotRequest(buildJoinRequest(), NOW)).not.toHaveProperty("automatic_audio_output");
  });

  it("sends the audio output alongside the avatar video output", () => {
    const body = buildRecallCreateBotRequest(buildJoinRequest(), NOW, AVATAR, buildAgent("DEEPGRAM", true));
    expect(body.automatic_video_output).toBeDefined();
    expect(body.automatic_audio_output).toStrictEqual(buildRecallAutomaticAudioOutput());
  });
});

describe("RecallBotGateway voice fallback", () => {
  const voiceAgent = buildAgent("DEEPGRAM", true);

  it("retries without voice but keeps the recording config when Recall rejects the audio output", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_audio_output"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await expect(
      createGateway({ client, agent: voiceAgent }).requestJoin(buildJoinRequest())
    ).resolves.toEqual({ externalRef: "bot-2" });

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[0][0]).toHaveProperty("automatic_audio_output");
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("automatic_audio_output");
    expect(client.createBot.mock.calls[1][0].recording_config).toStrictEqual(
      buildRecallRecordingConfig(voiceAgent)
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("audio output"));
  });

  it("does not retry an automatic_audio_output 400 when the agent has no voice", async () => {
    const client = createFakeClient();
    client.createBot.mockRejectedValue(badRequest(["automatic_audio_output"]));

    const error = await captureError(
      createGateway({ client, agent: buildAgent() }).requestJoin(buildJoinRequest())
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(1);
  });

  it("drops the avatar, the audio output and the agent in one retry when Recall rejects all three", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(
        badRequest(["automatic_video_output", "automatic_audio_output", "recording_config"])
      )
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await expect(
      createGateway({ client, agent: voiceAgent }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    ).resolves.toEqual({ externalRef: "bot-2" });

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[1][0]).toStrictEqual(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW)
    );
  });

  it("succeeds on the fourth call when each 400 drops a different part", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_video_output"]))
      .mockRejectedValueOnce(badRequest(["automatic_audio_output"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-4"));

    await expect(
      createGateway({ client, agent: voiceAgent }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    ).resolves.toEqual({ externalRef: "bot-4" });

    expect(client.createBot).toHaveBeenCalledTimes(4);
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("automatic_video_output");
    expect(client.createBot.mock.calls[1][0]).toHaveProperty("automatic_audio_output");
    expect(client.createBot.mock.calls[2][0]).not.toHaveProperty("automatic_audio_output");
    expect(client.createBot.mock.calls[2][0]).toHaveProperty("recording_config");
    expect(client.createBot.mock.calls[3][0]).toStrictEqual(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW)
    );
  });

  it("maps a fourth 400 to LINK_UNUSABLE once nothing is left to drop", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_video_output"]))
      .mockRejectedValueOnce(badRequest(["automatic_audio_output"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]));

    const error = await captureError(
      createGateway({ client, agent: voiceAgent }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(4);
  });
});

describe("buildRecallCreateBotRequest variant", () => {
  it("asks for the 4-core bot on every platform when the agent has a variant", () => {
    const body = buildRecallCreateBotRequest(buildJoinRequest(), NOW, null, {
      ...buildAgent(),
      variant: RECALL_WEB_4_CORE_VARIANT,
    });
    expect(body.variant).toStrictEqual({
      zoom: "web_4_core",
      google_meet: "web_4_core",
      microsoft_teams: "web_4_core",
    });
    expect(body.recording_config).toStrictEqual(buildRecallRecordingConfig(buildAgent()));
  });

  it("omits variant without an agent or when the variant was dropped", () => {
    expect(buildRecallCreateBotRequest(buildJoinRequest(), NOW, null, null)).not.toHaveProperty("variant");
    expect(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW, null, { ...buildAgent(), variant: null })
    ).not.toHaveProperty("variant");
  });
});

describe("RecallBotGateway variant fallback", () => {
  const browserAgent: RecallMeetingAgentOptions = {
    ...buildAgent("DEEPGRAM", true),
    variant: RECALL_WEB_4_CORE_VARIANT,
  };

  it("retries on the default bot but keeps the agent when Recall rejects the variant", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["variant"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await expect(
      createGateway({ client, agent: browserAgent }).requestJoin(buildJoinRequest())
    ).resolves.toEqual({ externalRef: "bot-2" });

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[0][0].variant).toStrictEqual(RECALL_WEB_4_CORE_VARIANT);
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("variant");
    expect(client.createBot.mock.calls[1][0].recording_config).toStrictEqual(
      buildRecallRecordingConfig(browserAgent)
    );
    expect(client.createBot.mock.calls[1][0].automatic_audio_output).toStrictEqual(
      buildRecallAutomaticAudioOutput()
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("variant"));
  });

  it("does not retry a variant 400 when the agent has no variant", async () => {
    const client = createFakeClient();
    client.createBot.mockRejectedValue(badRequest(["variant"]));

    const error = await captureError(
      createGateway({ client, agent: buildAgent() }).requestJoin(buildJoinRequest())
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(1);
  });

  it("drops the variant along with the whole agent when Recall rejects the recording config", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await expect(
      createGateway({ client, agent: browserAgent }).requestJoin(buildJoinRequest())
    ).resolves.toEqual({ externalRef: "bot-2" });

    expect(client.createBot.mock.calls[1][0]).toStrictEqual(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW)
    );
  });

  it("drops the variant and the audio output together but keeps the recording config", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["variant", "automatic_audio_output"]))
      .mockResolvedValueOnce(buildBot([], "bot-2"));

    await createGateway({ client, agent: browserAgent }).requestJoin(buildJoinRequest());

    expect(client.createBot).toHaveBeenCalledTimes(2);
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("variant");
    expect(client.createBot.mock.calls[1][0]).not.toHaveProperty("automatic_audio_output");
    expect(client.createBot.mock.calls[1][0].recording_config).toStrictEqual(
      buildRecallRecordingConfig(browserAgent)
    );
  });

  it("succeeds on the fifth call when each 400 drops a different part", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_video_output"]))
      .mockRejectedValueOnce(badRequest(["automatic_audio_output"]))
      .mockRejectedValueOnce(badRequest(["variant"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockResolvedValueOnce(buildBot([], "bot-5"));

    await expect(
      createGateway({ client, agent: browserAgent }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    ).resolves.toEqual({ externalRef: "bot-5" });

    expect(client.createBot).toHaveBeenCalledTimes(5);
    expect(client.createBot.mock.calls[2][0]).toHaveProperty("variant");
    expect(client.createBot.mock.calls[3][0]).not.toHaveProperty("variant");
    expect(client.createBot.mock.calls[3][0]).toHaveProperty("recording_config");
    expect(client.createBot.mock.calls[4][0]).toStrictEqual(
      buildRecallCreateBotRequest(buildJoinRequest(), NOW)
    );
  });

  it("maps a fifth 400 to LINK_UNUSABLE after four fallback retries", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    client.createBot
      .mockRejectedValueOnce(badRequest(["automatic_video_output"]))
      .mockRejectedValueOnce(badRequest(["automatic_audio_output"]))
      .mockRejectedValueOnce(badRequest(["variant"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]))
      .mockRejectedValueOnce(badRequest(["recording_config"]));

    const error = await captureError(
      createGateway({ client, agent: browserAgent }).requestJoin(buildJoinRequest(), { avatar: AVATAR })
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    expect(client.createBot).toHaveBeenCalledTimes(5);
  });
});

describe("getRecallMeetingAgentOptions", () => {
  const usable: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    NOTETAKER_AGENT_ENABLED: "true",
    NOTETAKER_BOT_PROVIDER: "recall",
    RECALL_API_KEY: "key-123",
    RECALL_WEBHOOK_VERIFICATION_SECRET: "whsec_c2VjcmV0LWtleS1ieXRlcw==",
    ANTHROPIC_API_KEY: "test-anthropic-key",
  };
  const configFor = (overrides: Record<string, string | undefined> = {}): NotetakerConfig =>
    getNotetakerConfig({ ...usable, ...overrides });

  it("is null when the agent is disabled", () => {
    expect(
      getRecallMeetingAgentOptions(
        configFor({ NOTETAKER_AGENT_ENABLED: undefined }),
        "https://app.example.com"
      )
    ).toBeNull();
  });

  it("is null when the agent is unusable", () => {
    expect(
      getRecallMeetingAgentOptions(configFor({ ANTHROPIC_API_KEY: undefined }), "https://app.example.com")
    ).toBeNull();
    expect(
      getRecallMeetingAgentOptions(configFor({ NOTETAKER_BOT_PROVIDER: "fake" }), "https://app.example.com")
    ).toBeNull();
  });

  it.each(["http://app.example.com", "not a url", ""])("is null for the webapp url %j", (webappUrl) => {
    expect(getRecallMeetingAgentOptions(configFor(), webappUrl)).toBeNull();
  });

  it.each([
    "https://app.example.com",
    "https://app.example.com/",
    "https://app.example.com/some/path",
  ])("points Recall at the realtime endpoint for %s", (webappUrl) => {
    expect(
      getRecallMeetingAgentOptions(configFor({ NOTETAKER_AGENT_SPEECH_PROVIDER: "deepgram" }), webappUrl)
    ).toStrictEqual({ realtimeUrl: REALTIME_URL, speechProvider: "DEEPGRAM", voice: false, keyterms: true });
  });

  it("passes the configured speech provider through", () => {
    expect(getRecallMeetingAgentOptions(configFor(), "https://app.example.com")).toStrictEqual({
      realtimeUrl: REALTIME_URL,
      speechProvider: "NONE",
      voice: false,
      keyterms: true,
    });
  });

  it("turns voice on when spoken replies are configured", () => {
    expect(
      getRecallMeetingAgentOptions(
        configFor({ NOTETAKER_AGENT_SPEECH_PROVIDER: "deepgram", ELEVENLABS_API_KEY: "el-key" }),
        "https://app.example.com"
      )?.voice
    ).toBe(true);
  });

  it.each([
    ["without an ElevenLabs key", { NOTETAKER_AGENT_SPEECH_PROVIDER: "deepgram" }],
    ["without a speech provider", { ELEVENLABS_API_KEY: "el-key" }],
    [
      "when voice is switched off",
      {
        NOTETAKER_AGENT_SPEECH_PROVIDER: "deepgram",
        ELEVENLABS_API_KEY: "el-key",
        NOTETAKER_AGENT_VOICE_ENABLED: "false",
      },
    ],
  ])("keeps voice off %s", (_label, overrides) => {
    expect(getRecallMeetingAgentOptions(configFor(overrides), "https://app.example.com")?.voice).toBe(false);
  });

  const browser = {
    NOTETAKER_AGENT_BROWSER_ENABLED: "true",
    AGENT_BROWSER_INTERNAL_URL: "http://127.0.0.1:4410",
    AGENT_BROWSER_PUBLIC_URL: "https://app.example.com/agent-browser",
    AGENT_BROWSER_SECRET: "s".repeat(32),
  };

  it("asks for the 4-core variant when the agent browser is usable", () => {
    expect(
      getRecallMeetingAgentOptions(configFor(browser), "https://app.example.com")?.variant
    ).toStrictEqual(RECALL_WEB_4_CORE_VARIANT);
  });

  it.each([
    ["when the browser is switched off", { ...browser, NOTETAKER_AGENT_BROWSER_ENABLED: "false" }],
    ["without an internal url", { ...browser, AGENT_BROWSER_INTERNAL_URL: undefined }],
    [
      "with a public url that is not https",
      { ...browser, AGENT_BROWSER_PUBLIC_URL: "http://app.example.com" },
    ],
    ["with a short secret", { ...browser, AGENT_BROWSER_SECRET: "short" }],
  ])("leaves the variant out %s", (_label, overrides) => {
    expect(getRecallMeetingAgentOptions(configFor(overrides), "https://app.example.com")).not.toHaveProperty(
      "variant"
    );
  });
});

describe("RecallBotGateway.requestStop", () => {
  const stop = { sessionId: SESSION_ID, reason: "STOPPED_BY_HOST" as const };

  it("does nothing when no bot can be found for the session", async () => {
    const client = createFakeClient();
    await createGateway({ client, externalRef: null }).requestStop(stop);

    expect(client.listBotsByMetadata).toHaveBeenCalledWith(RECALL_SESSION_METADATA_KEY, SESSION_ID);
    expect(client.retrieveBot).not.toHaveBeenCalled();
  });

  it("falls back to the session metadata when the external ref is missing", async () => {
    const client = createFakeClient({
      listBotsByMetadata: vi
        .fn<IRecallApiClient["listBotsByMetadata"]>()
        .mockResolvedValue([buildBot([], "bot-found")]),
      retrieveBot: vi
        .fn<IRecallApiClient["retrieveBot"]>()
        .mockResolvedValue(buildBot(["joining_call", "in_call_recording"], "bot-found")),
    });
    await createGateway({ client, externalRef: null }).requestStop(stop);

    expect(client.leaveCall).toHaveBeenCalledWith("bot-found");
  });

  it("does nothing when Recall no longer knows the bot", async () => {
    const client = createFakeClient();
    await createGateway({ client }).requestStop(stop);

    expect(client.retrieveBot).toHaveBeenCalledWith(BOT_ID);
    expect(client.deleteScheduledBot).not.toHaveBeenCalled();
    expect(client.leaveCall).not.toHaveBeenCalled();
  });

  it.each([[[]], [["ready"]]])("deletes a bot that has not joined yet (%j)", async (codes) => {
    const client = createFakeClient({
      retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>().mockResolvedValue(buildBot(codes)),
    });
    await createGateway({ client }).requestStop(stop);

    expect(client.deleteScheduledBot).toHaveBeenCalledWith(BOT_ID);
    expect(client.leaveCall).not.toHaveBeenCalled();
  });

  it("removes the bot from the call when it started joining before the delete", async () => {
    const client = createFakeClient({
      retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>().mockResolvedValue(buildBot(["ready"])),
      deleteScheduledBot: vi.fn<IRecallApiClient["deleteScheduledBot"]>().mockResolvedValue("NOT_DELETABLE"),
    });
    await createGateway({ client }).requestStop(stop);

    expect(client.leaveCall).toHaveBeenCalledWith(BOT_ID);
  });

  it.each([
    ["joining_call"],
    ["in_waiting_room"],
    ["in_call_recording"],
  ])("removes a %s bot from the call", async (code) => {
    const client = createFakeClient({
      retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>().mockResolvedValue(buildBot(["ready", code])),
    });
    await createGateway({ client }).requestStop(stop);

    expect(client.deleteScheduledBot).not.toHaveBeenCalled();
    expect(client.leaveCall).toHaveBeenCalledWith(BOT_ID);
  });

  it.each([["call_ended"], ["done"], ["fatal"]])("does nothing once the bot reached %s", async (code) => {
    const client = createFakeClient({
      retrieveBot: vi
        .fn<IRecallApiClient["retrieveBot"]>()
        .mockResolvedValue(buildBot(["joining_call", "in_call_recording", code])),
    });
    await createGateway({ client }).requestStop(stop);

    expect(client.leaveCall).not.toHaveBeenCalled();
    expect(client.deleteScheduledBot).not.toHaveBeenCalled();
  });

  it.each(["NOT_FOUND", "NOT_IN_CALL"] as const)("resolves when leaving reports %s", async (result) => {
    const client = createFakeClient({
      retrieveBot: vi
        .fn<IRecallApiClient["retrieveBot"]>()
        .mockResolvedValue(buildBot(["in_call_recording"])),
      leaveCall: vi.fn<IRecallApiClient["leaveCall"]>().mockResolvedValue(result),
    });

    await expect(createGateway({ client }).requestStop(stop)).resolves.toBeUndefined();
  });

  it.each([
    "RATE_LIMITED",
    "UNAVAILABLE",
    "HTTP",
    "NETWORK",
    "TIMEOUT",
  ] as const)("reports TRANSIENT when the client fails with %s", async (kind) => {
    const client = createFakeClient({
      retrieveBot: vi
        .fn<IRecallApiClient["retrieveBot"]>()
        .mockResolvedValue(buildBot(["in_call_recording"])),
      leaveCall: vi.fn<IRecallApiClient["leaveCall"]>().mockRejectedValue(createRecallApiError(kind, "x")),
    });

    const error = await captureError(createGateway({ client }).requestStop(stop));
    expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
  });
});

describe("RecallBotGateway.getState", () => {
  it("returns null when no bot can be found for the session", async () => {
    const client = createFakeClient();
    await expect(createGateway({ client, externalRef: null }).getState(SESSION_ID)).resolves.toBeNull();
  });

  it("returns null when Recall no longer knows the bot", async () => {
    const client = createFakeClient();
    await expect(createGateway({ client }).getState(SESSION_ID)).resolves.toBeNull();
  });

  it.each([
    [["ready"], "STARTING"],
    [["joining_call", "in_waiting_room"], "WAITING"],
    [["joining_call", "in_call_recording"], "IN_MEETING"],
    [["joining_call", "in_call_recording", "call_ended"], "ENDED"],
  ] as const)("maps %j to %s", async (codes, phase) => {
    const client = createFakeClient({
      retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>().mockResolvedValue(buildBot([...codes])),
    });

    await expect(createGateway({ client }).getState(SESSION_ID)).resolves.toEqual({
      sessionId: SESSION_ID,
      phase,
      lastEventSequence: 0,
    });
  });

  it("reports TRANSIENT when the client fails", async () => {
    const client = createFakeClient({
      retrieveBot: vi
        .fn<IRecallApiClient["retrieveBot"]>()
        .mockRejectedValue(createRecallApiError("UNAVAILABLE", "x")),
    });

    const error = await captureError(createGateway({ client }).getState(SESSION_ID));
    expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
  });
});
