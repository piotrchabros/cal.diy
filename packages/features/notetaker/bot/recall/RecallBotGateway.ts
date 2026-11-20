import logger from "@calcom/lib/logger";
import type {
  NotetakerBotJoinRequest,
  NotetakerBotStateDto,
  NotetakerBotStopReason,
} from "@calcom/lib/notetaker/botContract";
import type { NotetakerAgentSpeechProvider, NotetakerConfig } from "../../lib/config";
import { isNotetakerAgentUsable, isNotetakerAgentVoiceUsable } from "../../lib/config";
import type {
  INotetakerBotGateway,
  NotetakerBotAvatar,
  NotetakerBotJoinOptions,
} from "../INotetakerBotGateway";
import { createNotetakerBotGatewayError } from "../INotetakerBotGateway";
import type { IRecallApiClient } from "./RecallApiClient";
import { getRecallApiErrorInfo } from "./RecallApiClient";
import { findRecallTerminalStatus, getRecallBotPhase, isRecallBotDone } from "./recallEventTranslation";
import type {
  RecallAutomaticAudioOutput,
  RecallBot,
  RecallCreateBotRequest,
  RecallRealtimeEventName,
  RecallRecordingConfig,
} from "./recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "./recallSchemas";
import { RECALL_SILENT_MP3_BASE64 } from "./silentMp3";

const MAX_BOT_NAME_LENGTH = 100;
// Google Meet caps chat messages at 500 characters, the lowest of the supported platforms.
const MAX_CHAT_MESSAGE_LENGTH = 500;
// Recall rejects a join_at in the past, so a start this close to now could already be past once
// request latency and clock skew are counted. Omitting join_at makes Recall dispatch the bot immediately.
const IMMEDIATE_JOIN_MARGIN_MS = 60_000;
const MAX_REPORTED_FIELDS = 10;
const MAX_CREATE_BOT_FALLBACK_RETRIES = 3;

export const RECALL_REALTIME_ENDPOINT_PATH = "/api/notetaker/recall/realtime";

export type RecallMeetingAgentOptions = {
  realtimeUrl: string;
  speechProvider: NotetakerAgentSpeechProvider;
  voice: boolean;
};

export function getRecallMeetingAgentOptions(
  config: NotetakerConfig,
  webappUrl: string
): RecallMeetingAgentOptions | null {
  if (!isNotetakerAgentUsable(config)) return null;
  // Recall only delivers realtime events to a publicly reachable HTTPS endpoint.
  let parsed: URL;
  try {
    parsed = new URL(webappUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return {
    realtimeUrl: new URL(RECALL_REALTIME_ENDPOINT_PATH, webappUrl).toString(),
    speechProvider: config.agent.speechProvider,
    voice: isNotetakerAgentVoiceUsable(config),
  };
}

export function buildRecallRecordingConfig(agent: RecallMeetingAgentOptions): RecallRecordingConfig {
  const realtimeEndpoint = (
    events: RecallRealtimeEventName[]
  ): RecallRecordingConfig["realtime_endpoints"] => [{ type: "webhook", url: agent.realtimeUrl, events }];
  switch (agent.speechProvider) {
    case "DEEPGRAM":
      return {
        transcript: {
          provider: { deepgram_streaming: { model: "nova-3", language: "multi", mip_opt_out: true } },
        },
        realtime_endpoints: realtimeEndpoint(["participant_events.chat_message", "transcript.data"]),
      };
    case "RECALLAI_EN":
      return {
        transcript: {
          provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
        },
        realtime_endpoints: realtimeEndpoint(["participant_events.chat_message", "transcript.data"]),
      };
    case "NONE":
      return { realtime_endpoints: realtimeEndpoint(["participant_events.chat_message"]) };
  }
}

// Recall only accepts output_audio calls from a bot created with automatic_audio_output, so a short
// silent clip enables spoken replies without the bot making any sound on join.
export function buildRecallAutomaticAudioOutput(): RecallAutomaticAudioOutput {
  return { in_call_recording: { data: { kind: "mp3", b64_data: RECALL_SILENT_MP3_BASE64 } } };
}

export function buildRecallCreateBotRequest(
  input: NotetakerBotJoinRequest,
  now: Date,
  avatar?: NotetakerBotAvatar | null,
  agent?: RecallMeetingAgentOptions | null
): RecallCreateBotRequest {
  const scheduledStartMs = new Date(input.scheduledStartAt).getTime();
  const isScheduledJoin = scheduledStartMs > now.getTime() + IMMEDIATE_JOIN_MARGIN_MS;
  return {
    meeting_url: input.meetingUrl,
    bot_name: input.displayName.slice(0, MAX_BOT_NAME_LENGTH),
    ...(isScheduledJoin ? { join_at: new Date(scheduledStartMs).toISOString() } : {}),
    ...(avatar
      ? {
          automatic_video_output: {
            in_call_recording: { kind: avatar.kind, b64_data: avatar.base64 },
            in_call_not_recording: { kind: avatar.kind, b64_data: avatar.base64 },
          },
        }
      : {}),
    ...(agent?.voice ? { automatic_audio_output: buildRecallAutomaticAudioOutput() } : {}),
    metadata: { [RECALL_SESSION_METADATA_KEY]: input.sessionId },
    chat: {
      on_bot_join: {
        send_to: "everyone",
        message: input.noticeMessage.slice(0, MAX_CHAT_MESSAGE_LENGTH),
        pin: true,
      },
    },
    automatic_leave: {
      waiting_room_timeout: input.limits.admissionTimeoutSeconds,
      noone_joined_timeout: input.limits.noShowTimeoutSeconds,
      // Recall rejects activate_after: 0 (minimum 1); omitting it stores null, which means no delay.
      everyone_left_timeout: { timeout: input.limits.aloneTimeoutSeconds },
      in_call_recording_timeout: input.limits.maxDurationSeconds,
    },
    ...(agent ? { recording_config: buildRecallRecordingConfig(agent) } : {}),
  };
}

function hasNotJoined(bot: RecallBot): boolean {
  return bot.status_changes.every((change) => change.code === "ready");
}

function isTerminal(bot: RecallBot): boolean {
  return findRecallTerminalStatus(bot) !== null || isRecallBotDone(bot);
}

function describeRecallBadRequest(fieldNames: string[]): string {
  if (fieldNames.includes("meeting_url")) return "Recall rejected the meeting URL (status 400)";
  const fields = fieldNames.length > 0 ? fieldNames.slice(0, MAX_REPORTED_FIELDS).join(", ") : "none";
  return `Recall rejected the create bot request (status 400, fields: ${fields})`;
}

function toTransientError(error: unknown, operation: string): unknown {
  const info = getRecallApiErrorInfo(error);
  if (!info) return error;
  const status = info.status === null ? "" : ` (status ${info.status})`;
  return createNotetakerBotGatewayError("TRANSIENT", `Recall ${operation} failed: ${info.kind}${status}`);
}

export class RecallBotGateway implements INotetakerBotGateway {
  private readonly client: IRecallApiClient;
  private readonly findExternalRef: (sessionId: string) => Promise<string | null>;
  private readonly now: () => Date;
  private readonly agent: RecallMeetingAgentOptions | null;

  constructor(deps: {
    client: IRecallApiClient;
    findExternalRef: (sessionId: string) => Promise<string | null>;
    now?: () => Date;
    agent?: RecallMeetingAgentOptions | null;
  }) {
    this.client = deps.client;
    this.findExternalRef = deps.findExternalRef;
    this.now = deps.now ?? (() => new Date());
    this.agent = deps.agent ?? null;
  }

  async requestJoin(
    input: NotetakerBotJoinRequest,
    options?: NotetakerBotJoinOptions
  ): Promise<{ externalRef: string }> {
    const avatar = options?.avatar ?? null;
    try {
      const bot = await this.createBotWithFallbacks(input, avatar);
      return { externalRef: bot.id };
    } catch (error) {
      const info = getRecallApiErrorInfo(error);
      // Recall answers 400 only to a request it will never accept, so the sweep's per-minute retry
      // cannot succeed; the session fails instead. Only field names are reported: values can echo the URL.
      if (info?.kind === "BAD_REQUEST") {
        throw createNotetakerBotGatewayError("LINK_UNUSABLE", describeRecallBadRequest(info.fieldNames));
      }
      // The bot may have been created even though the response never arrived; a retry would add a second one.
      if (info?.kind === "NETWORK" || info?.kind === "TIMEOUT") {
        const existing = await this.findBotBySessionMetadata(input.sessionId).catch(() => null);
        if (existing) return { externalRef: existing.id };
      }
      const reason = info ? info.kind : "unexpected error";
      throw createNotetakerBotGatewayError("TRANSIENT", `Recall create bot failed: ${reason}`);
    }
  }

  // An image or a bad agent setup Recall cannot accept must never stop note-taking, so each optional
  // part it rejects is dropped and the request retried without it.
  private async createBotWithFallbacks(
    input: NotetakerBotJoinRequest,
    avatar: NotetakerBotAvatar | null
  ): Promise<RecallBot> {
    let currentAvatar = avatar;
    let currentAgent = this.agent;
    for (let retries = 0; ; retries++) {
      try {
        return await this.client.createBot(
          buildRecallCreateBotRequest(input, this.now(), currentAvatar, currentAgent)
        );
      } catch (error) {
        const info = getRecallApiErrorInfo(error);
        if (info?.kind !== "BAD_REQUEST" || retries >= MAX_CREATE_BOT_FALLBACK_RETRIES) throw error;
        let dropped = false;
        if (currentAvatar !== null && info.fieldNames.includes("automatic_video_output")) {
          logger.warn("Recall rejected the notetaker avatar; retrying the create bot request without it");
          currentAvatar = null;
          dropped = true;
        }
        if (currentAgent?.voice && info.fieldNames.includes("automatic_audio_output")) {
          logger.warn(
            "Recall rejected the meeting agent audio output; retrying the create bot request without voice, chat replies continue"
          );
          currentAgent = { ...currentAgent, voice: false };
          dropped = true;
        }
        if (currentAgent !== null && info.fieldNames.includes("recording_config")) {
          logger.warn(
            "Recall rejected the meeting agent recording config; retrying the create bot request without the agent, note-taking continues"
          );
          currentAgent = null;
          dropped = true;
        }
        if (!dropped) throw error;
      }
    }
  }

  async requestStop(input: { sessionId: string; reason: NotetakerBotStopReason }): Promise<void> {
    try {
      const botId = await this.resolveBotId(input.sessionId);
      if (!botId) return;
      const bot = await this.client.retrieveBot(botId);
      if (!bot || isTerminal(bot)) return;

      if (hasNotJoined(bot)) {
        const deleted = await this.client.deleteScheduledBot(botId);
        if (deleted !== "NOT_DELETABLE") return;
      }
      // NOT_FOUND and NOT_IN_CALL both mean there is no call left to leave.
      await this.client.leaveCall(botId);
    } catch (error) {
      throw toTransientError(error, "stop");
    }
  }

  async getState(sessionId: string): Promise<NotetakerBotStateDto | null> {
    try {
      const botId = await this.resolveBotId(sessionId);
      if (!botId) return null;
      const bot = await this.client.retrieveBot(botId);
      if (!bot) return null;
      // Recall has no event sequence of its own; webhook sync assigns fixed sequences instead.
      return { sessionId, phase: getRecallBotPhase(bot), lastEventSequence: 0 };
    } catch (error) {
      throw toTransientError(error, "get state");
    }
  }

  private async resolveBotId(sessionId: string): Promise<string | null> {
    const externalRef = await this.findExternalRef(sessionId);
    if (externalRef) return externalRef;
    // externalRef is empty when requestJoin's response was lost, so the bot is found by its metadata.
    const bot = await this.findBotBySessionMetadata(sessionId);
    return bot?.id ?? null;
  }

  private async findBotBySessionMetadata(sessionId: string): Promise<RecallBot | null> {
    const bots = await this.client.listBotsByMetadata(RECALL_SESSION_METADATA_KEY, sessionId);
    return bots[0] ?? null;
  }
}
