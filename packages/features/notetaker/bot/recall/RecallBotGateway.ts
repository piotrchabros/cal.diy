import type {
  NotetakerBotJoinRequest,
  NotetakerBotStateDto,
  NotetakerBotStopReason,
} from "@calcom/lib/notetaker/botContract";
import type { INotetakerBotGateway } from "../INotetakerBotGateway";
import { createNotetakerBotGatewayError } from "../INotetakerBotGateway";
import type { IRecallApiClient } from "./RecallApiClient";
import { getRecallApiErrorInfo } from "./RecallApiClient";
import { findRecallTerminalStatus, getRecallBotPhase, isRecallBotDone } from "./recallEventTranslation";
import type { RecallBot, RecallCreateBotRequest } from "./recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "./recallSchemas";

const MAX_BOT_NAME_LENGTH = 100;
// Google Meet caps chat messages at 500 characters, the lowest of the supported platforms.
const MAX_CHAT_MESSAGE_LENGTH = 500;
// Recall rejects a join_at in the past, so a start this close to now could already be past once
// request latency and clock skew are counted. Omitting join_at makes Recall dispatch the bot immediately.
const IMMEDIATE_JOIN_MARGIN_MS = 60_000;
const MAX_REPORTED_FIELDS = 10;

export function buildRecallCreateBotRequest(
  input: NotetakerBotJoinRequest,
  now: Date
): RecallCreateBotRequest {
  const scheduledStartMs = new Date(input.scheduledStartAt).getTime();
  const isScheduledJoin = scheduledStartMs > now.getTime() + IMMEDIATE_JOIN_MARGIN_MS;
  return {
    meeting_url: input.meetingUrl,
    bot_name: input.displayName.slice(0, MAX_BOT_NAME_LENGTH),
    ...(isScheduledJoin ? { join_at: new Date(scheduledStartMs).toISOString() } : {}),
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

  constructor(deps: {
    client: IRecallApiClient;
    findExternalRef: (sessionId: string) => Promise<string | null>;
    now?: () => Date;
  }) {
    this.client = deps.client;
    this.findExternalRef = deps.findExternalRef;
    this.now = deps.now ?? (() => new Date());
  }

  async requestJoin(input: NotetakerBotJoinRequest): Promise<{ externalRef: string }> {
    try {
      const bot = await this.client.createBot(buildRecallCreateBotRequest(input, this.now()));
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
