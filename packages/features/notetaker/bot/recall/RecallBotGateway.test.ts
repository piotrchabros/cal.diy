import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { notetakerBotJoinRequestSchema } from "@calcom/lib/notetaker/botContract";
import { describe, expect, it, vi } from "vitest";
import { getNotetakerBotGatewayFailure } from "../INotetakerBotGateway";
import type { IRecallApiClient } from "./RecallApiClient";
import { createRecallApiError } from "./RecallApiClient";
import { buildRecallCreateBotRequest, RecallBotGateway } from "./RecallBotGateway";
import type { RecallBot } from "./recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "./recallSchemas";

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

function createFakeClient(overrides: Partial<IRecallApiClient> = {}) {
  const client = {
    createBot: vi.fn<IRecallApiClient["createBot"]>().mockResolvedValue(buildBot()),
    retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>().mockResolvedValue(null),
    listBotsByMetadata: vi.fn<IRecallApiClient["listBotsByMetadata"]>().mockResolvedValue([]),
    leaveCall: vi.fn<IRecallApiClient["leaveCall"]>().mockResolvedValue("OK"),
    deleteScheduledBot: vi.fn<IRecallApiClient["deleteScheduledBot"]>().mockResolvedValue("OK"),
    createTranscript: vi.fn<IRecallApiClient["createTranscript"]>().mockResolvedValue({ id: "t-1" }),
    retrieveTranscript: vi.fn<IRecallApiClient["retrieveTranscript"]>().mockResolvedValue(null),
    downloadTranscript: vi.fn<IRecallApiClient["downloadTranscript"]>().mockResolvedValue([]),
  };
  return Object.assign(client, overrides);
}

function createGateway(input: { client: IRecallApiClient; externalRef?: string | null }): RecallBotGateway {
  const externalRef = input.externalRef === undefined ? BOT_ID : input.externalRef;
  return new RecallBotGateway({
    client: input.client,
    findExternalRef: async () => externalRef,
    now: () => NOW,
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
        everyone_left_timeout: { timeout: 120, activate_after: 0 },
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
  });

  it("reports TRANSIENT for a bad request that does not concern the meeting URL", async () => {
    const client = createFakeClient({
      createBot: vi
        .fn<IRecallApiClient["createBot"]>()
        .mockRejectedValue(
          createRecallApiError("BAD_REQUEST", "bad", { status: 400, fieldNames: ["join_at"] })
        ),
    });

    const error = await captureError(createGateway({ client }).requestJoin(buildJoinRequest()));
    expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
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
