import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { IMeetingAgent, MeetingAgentLine, MeetingAgentSource } from "../agent/IMeetingAgent";
import { MeetingAgentStateStore } from "../agent/MeetingAgentStateStore";
import {
  chatMessageToPlainText,
  parseMeetingAgentTrigger,
  splitChatMessage,
  stripLeadingAgentName,
  utteranceWordsToText,
} from "../agent/meetingAgentText";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { getRecallApiErrorInfo } from "../bot/recall/RecallApiClient";
import type { RecallRealtimeEnvelope } from "../bot/recall/recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "../bot/recall/recallSchemas";
import type { NotetakerConfig } from "../lib/config";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
} from "../repositories/interfaces/INotetakerSessionRepository";

const COMMAND_LIMIT_MESSAGE = "Command limit reached for this meeting.";
const AGENT_FAILURE_MESSAGE = "Sorry, I could not complete that.";

const LIVE_STATUSES = new Set<NotetakerSessionRecord["status"]>(["WAITING_TO_BE_ADMITTED", "TRANSCRIBING"]);

type AgentRunContext = {
  agent: IMeetingAgent;
  botId: string;
  sessionId: string;
  command: string;
  speakerName: string | null;
  source: MeetingAgentSource;
  recentLines: MeetingAgentLine[];
};

function getErrorKind(error: unknown): string {
  return getRecallApiErrorInfo(error)?.kind ?? "UNKNOWN";
}

function getEventText(envelope: RecallRealtimeEnvelope): { source: MeetingAgentSource; text: string } | null {
  const payload = envelope.data.data;
  if (envelope.event === "participant_events.chat_message") {
    const raw = payload?.data?.text;
    return raw ? { source: "CHAT", text: chatMessageToPlainText(raw) } : null;
  }
  if (envelope.event === "transcript.data") {
    const words = payload?.words;
    return words ? { source: "SPEECH", text: utteranceWordsToText(words) } : null;
  }
  return null;
}

export const MEETING_AGENT_COMMANDS_PER_MINUTE = 4;

export type RecallRealtimeOutcome =
  | "DISABLED"
  | "IGNORED"
  | "DUPLICATE"
  | "BUFFERED"
  | "RATE_LIMITED"
  | "HANDLED";

export interface IRecallRealtimeEventServiceDeps {
  recallClient: IRecallApiClient;
  sessionRepository: INotetakerSessionRepository;
  meetingAgent: IMeetingAgent | null;
  config: NotetakerConfig;
  logger: ISimpleLogger;
}

export class RecallRealtimeEventService {
  // The agent runs for one bot are serialized so replies to consecutive commands never interleave in chat.
  private readonly queues = new Map<string, Promise<void>>();

  private readonly store: MeetingAgentStateStore;

  private readonly now: () => Date;

  // store and now stay out of the deps map because bindModuleToClassOnToken requires every deps key to be bound.
  constructor(
    private readonly deps: IRecallRealtimeEventServiceDeps,
    options: { store?: MeetingAgentStateStore; now?: () => Date } = {}
  ) {
    this.store = options.store ?? new MeetingAgentStateStore();
    this.now = options.now ?? (() => new Date());
  }

  async handle(envelope: RecallRealtimeEnvelope, deliveryId: string | null): Promise<RecallRealtimeOutcome> {
    const { meetingAgent, sessionRepository, config } = this.deps;
    if (!meetingAgent) return "DISABLED";

    const now = this.now();
    const botId = envelope.data.bot.id;
    if (deliveryId && !this.store.markDelivery(botId, deliveryId, now)) return "DUPLICATE";

    const sessionId = envelope.data.bot.metadata?.[RECALL_SESSION_METADATA_KEY];
    const participant = envelope.data.data?.participant;
    if (!botId || typeof sessionId !== "string" || !participant) return "IGNORED";

    const event = getEventText(envelope);
    if (!event || event.text === "") return "IGNORED";
    const { source, text } = event;

    // Recall also delivers the bot's own chat messages; a reply quoting a command must not trigger again.
    if (source === "CHAT" && this.store.wasSentByBot(botId, text, now)) return "IGNORED";

    const speakerName = participant.name ?? null;
    this.store.appendLine(botId, { source, speakerName, text, at: now });
    const recentLines = this.store.getRecentLines(botId).slice(0, -1);

    let command: string;
    const trigger = parseMeetingAgentTrigger(text);
    if (!trigger) {
      // A speaker who said only the name gets the next utterance treated as the command, because
      // transcription often splits "BlueBeeBot, ... " into two sentences at the pause after the name.
      if (source !== "SPEECH" || !this.store.takePendingTrigger(botId, participant.id, now)) {
        return "BUFFERED";
      }
      command = text;
    } else if (trigger.command === "" && source === "SPEECH") {
      this.store.setPendingTrigger(botId, participant.id, now);
      return "BUFFERED";
    } else {
      command = trigger.command;
    }

    if (this.store.isDuplicateCommand(botId, `${participant.id}`, command, now)) return "DUPLICATE";

    const session = await sessionRepository.findById(sessionId);
    if (
      !session ||
      session.botProvider !== "RECALL" ||
      (session.externalRef !== null && session.externalRef !== botId) ||
      !LIVE_STATUSES.has(session.status)
    ) {
      return "IGNORED";
    }
    // The bot's chat messages carry its display name; this catches echoes the sent-message memory missed.
    if (source === "CHAT" && participant.name === session.displayName) return "IGNORED";

    const consumed = this.store.tryConsumeCommand(botId, now, {
      perMinute: MEETING_AGENT_COMMANDS_PER_MINUTE,
      perMeeting: config.agent.maxCommandsPerMeeting,
    });
    if (consumed !== "OK") {
      this.deps.logger.info("Meeting agent command was rate limited", {
        botId,
        sessionId,
        outcome: consumed,
        kind: source,
      });
      if (consumed === "MEETING_LIMIT" && this.store.markLimitNoticeSent(botId)) {
        await this.postBestEffort(botId, sessionId, COMMAND_LIMIT_MESSAGE);
      }
      return "RATE_LIMITED";
    }

    await this.enqueue(botId, () =>
      this.runAgent({ agent: meetingAgent, botId, sessionId, command, speakerName, source, recentLines })
    );
    return "HANDLED";
  }

  private async enqueue(botId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(botId) ?? Promise.resolve();
    const run = previous.then(task);
    // The tail swallows the outcome so one failed run never rejects the runs queued after it.
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(botId, tail);
    try {
      await run;
    } finally {
      if (this.queues.get(botId) === tail) this.queues.delete(botId);
    }
  }

  private async runAgent(context: AgentRunContext): Promise<void> {
    const { recallClient, logger } = this.deps;
    const { agent, botId, sessionId, source } = context;
    try {
      const result = await agent.run(
        {
          command: context.command,
          speakerName: context.speakerName,
          source,
          recentLines: context.recentLines,
        },
        {
          sendChatMessage: async (text) => {
            const reply = stripLeadingAgentName(text);
            for (const part of splitChatMessage(reply)) {
              await this.postChatMessage(botId, part);
            }
            // Recording the whole reply lets later commands see the bot's earlier answers; its chat echo is ignored.
            this.store.appendLine(botId, { source: "AGENT", speakerName: null, text: reply, at: this.now() });
          },
          startScreenshare: (url) => recallClient.startScreenshare(botId, url),
          stopScreenshare: async () => {
            await recallClient.stopScreenshare(botId);
          },
        }
      );
      logger.info("Meeting agent run finished", { botId, sessionId, outcome: result.outcome, kind: source });
      if (result.outcome === "FAILED" || result.outcome === "LOOP_LIMIT") {
        await this.postBestEffort(botId, sessionId, AGENT_FAILURE_MESSAGE);
      }
    } catch (error) {
      logger.warn("Meeting agent run failed", {
        botId,
        sessionId,
        outcome: "FAILED",
        kind: getErrorKind(error),
      });
    }
  }

  private async postChatMessage(botId: string, message: string): Promise<void> {
    this.store.recordSentMessage(botId, message, this.now());
    await this.deps.recallClient.sendChatMessage(botId, { to: "everyone", message });
  }

  private async postBestEffort(botId: string, sessionId: string, message: string): Promise<void> {
    try {
      await this.postChatMessage(botId, message);
    } catch (error) {
      this.deps.logger.warn("Failed to post a meeting agent notice", {
        botId,
        sessionId,
        kind: getErrorKind(error),
      });
    }
  }
}
