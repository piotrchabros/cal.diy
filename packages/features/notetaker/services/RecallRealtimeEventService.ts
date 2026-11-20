import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type {
  IMeetingAgent,
  MeetingAgentLine,
  MeetingAgentRunResult,
  MeetingAgentSource,
} from "../agent/IMeetingAgent";
import { MeetingAgentStateStore } from "../agent/MeetingAgentStateStore";
import {
  chatMessageToPlainText,
  looksLikeAgentNameNearMiss,
  parseMeetingAgentTrigger,
  splitChatMessage,
  stripLeadingAgentName,
  toSpokenText,
  utteranceWordsToText,
} from "../agent/meetingAgentText";
import type { IMeetingAgentSpeechSynthesizer } from "../agent/tts/IMeetingAgentSpeechSynthesizer";
import { getSpeechSynthesisErrorKind } from "../agent/tts/IMeetingAgentSpeechSynthesizer";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { getRecallApiErrorInfo } from "../bot/recall/RecallApiClient";
import type { RecallRealtimeEnvelope } from "../bot/recall/recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "../bot/recall/recallSchemas";
import type { MeetingAgentBrowserService } from "../browser/MeetingAgentBrowserService";
import type { NotetakerConfig } from "../lib/config";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
} from "../repositories/interfaces/INotetakerSessionRepository";

const COMMAND_LIMIT_MESSAGE = "Command limit reached for this meeting.";
const AGENT_FAILURE_MESSAGE = "Sorry, I could not complete that.";
const ACK_MESSAGE = "On it…";
const POLISH_ACK_MESSAGE = "Już się tym zajmuję…";

const POLISH_DIACRITICS = /[ąćęłńóśźż]/i;
const POLISH_WORDS = new Set([
  "czy",
  "jak",
  "jest",
  "nie",
  "się",
  "proszę",
  "pokaż",
  "otwórz",
  "znajdź",
  "sprawdź",
  "zrób",
  "podaj",
  "gdzie",
  "kiedy",
  "ile",
]);

const LIVE_STATUSES = new Set<NotetakerSessionRecord["status"]>(["WAITING_TO_BE_ADMITTED", "TRANSCRIBING"]);

type AgentRunContext = {
  agent: IMeetingAgent;
  botId: string;
  sessionId: string;
  command: string;
  speakerName: string | null;
  source: MeetingAgentSource;
  recentLines: MeetingAgentLine[];
  enqueuedAt: number;
};

function looksPolish(text: string): boolean {
  if (POLISH_DIACRITICS.test(text)) return true;
  return text
    .toLowerCase()
    .split(/[^a-ząćęłńóśźż]+/)
    .some((word) => POLISH_WORDS.has(word));
}

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

export const MAX_SPEECH_WAIT_MS = 45_000;

export const DEFAULT_ACK_DELAY_MS = 4_000;

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
  speechSynthesizer: IMeetingAgentSpeechSynthesizer | null;
  agentBrowser?: MeetingAgentBrowserService | null;
  config: NotetakerConfig;
  logger: ISimpleLogger;
}

export class RecallRealtimeEventService {
  // The agent runs for one bot are serialized so replies to consecutive commands never interleave in chat.
  private readonly queues = new Map<string, Promise<void>>();

  // Epoch ms at which the bot's last spoken clip ends, so the next clip starts after it.
  private readonly speakingUntil = new Map<string, number>();

  private readonly store: MeetingAgentStateStore;

  private readonly now: () => Date;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly ackDelayMs: number;

  // store, now, sleep and ackDelayMs stay out of the deps map because bindModuleToClassOnToken requires every deps key to be bound.
  constructor(
    private readonly deps: IRecallRealtimeEventServiceDeps,
    options: {
      store?: MeetingAgentStateStore;
      now?: () => Date;
      sleep?: (ms: number) => Promise<void>;
      ackDelayMs?: number;
    } = {}
  ) {
    this.store = options.store ?? new MeetingAgentStateStore();
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.ackDelayMs = options.ackDelayMs ?? DEFAULT_ACK_DELAY_MS;
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
        // Transcription often misspells the agent's name; without this nobody can tell why a command was ignored.
        if (looksLikeAgentNameNearMiss(text)) {
          this.deps.logger.warn("Meeting agent ignored a possible mention", {
            botId,
            sessionId,
            kind: source,
            length: text.length,
          });
        }
        return "BUFFERED";
      }
      command = text;
    } else if (trigger.command === "" && source === "SPEECH") {
      this.store.setPendingTrigger(botId, participant.id, now);
      return "BUFFERED";
    } else {
      command = trigger.command;
    }

    if (this.store.isDuplicateCommand(botId, `${participant.id}`, command, now)) {
      this.deps.logger.warn("Meeting agent dropped a duplicate command", { botId, sessionId, kind: source });
      return "DUPLICATE";
    }

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
      this.deps.logger.warn("Meeting agent command was rate limited", {
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

    const enqueuedAt = this.now().getTime();
    await this.enqueue(botId, () =>
      this.runAgent({
        agent: meetingAgent,
        botId,
        sessionId,
        command,
        speakerName,
        source,
        recentLines,
        enqueuedAt,
      })
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
      if (this.queues.get(botId) === tail) {
        this.queues.delete(botId);
        if ((this.speakingUntil.get(botId) ?? 0) <= this.now().getTime()) this.speakingUntil.delete(botId);
      }
    }
  }

  private async runAgent(context: AgentRunContext): Promise<void> {
    const { recallClient, logger } = this.deps;
    const { agent, botId, sessionId, source } = context;
    const speak = source === "SPEECH" && this.deps.speechSynthesizer !== null;
    const startedAt = this.now().getTime();
    const queuedMs = startedAt - context.enqueuedAt;
    const ackMessage = looksPolish(context.command) ? POLISH_ACK_MESSAGE : ACK_MESSAGE;

    // Long runs (browser mode can take minutes) leave the meeting thinking the bot did not hear,
    // so a run that stays silent past the delay posts one short acknowledgement first.
    let acked = false;
    let replied = false;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingAck: Promise<void> = Promise.resolve();
    const postAck = () => {
      ackTimer = null;
      if (replied || acked) return;
      acked = true;
      // The ack goes through postChatMessage so its echo is ignored, but it is not an AGENT line.
      pendingAck = this.postBestEffort(botId, sessionId, ackMessage).then((posted) => {
        acked = posted;
      });
    };
    const cancelAck = () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = null;
    };

    if (queuedMs > this.ackDelayMs) {
      postAck();
      await pendingAck;
    } else {
      ackTimer = setTimeout(postAck, this.ackDelayMs);
    }

    let result: MeetingAgentRunResult | null = null;
    try {
      result = await agent.run(
        {
          command: context.command,
          speakerName: context.speakerName,
          source,
          recentLines: context.recentLines,
        },
        {
          sendChatMessage: async (text) => {
            replied = true;
            cancelAck();
            // An ack already in flight must land before the reply so chat reads in order.
            await pendingAck;
            const reply = stripLeadingAgentName(text);
            for (const part of splitChatMessage(reply)) {
              await this.postChatMessage(botId, part);
            }
            // Recording the whole reply lets later commands see the bot's earlier answers; its chat echo is ignored.
            this.store.appendLine(botId, { source: "AGENT", speakerName: null, text: reply, at: this.now() });
            if (speak) await this.speakBestEffort(botId, sessionId, reply);
          },
          startScreenshare: (url) => recallClient.startScreenshare(botId, url),
          stopScreenshare: async () => {
            await recallClient.stopScreenshare(botId);
          },
          browser: this.deps.agentBrowser?.forBot(botId) ?? null,
        }
      );
      cancelAck();
      await pendingAck;
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
    } finally {
      cancelAck();
      await pendingAck;
      // Production logs keep only warn and above, so every run's outcome is logged at warn, never its text.
      logger.warn("Meeting agent run", {
        botId,
        sessionId,
        kind: source,
        outcome: result?.outcome ?? "FAILED",
        ...(result ? { iterations: result.iterations } : {}),
        durationMs: this.now().getTime() - startedAt,
        queuedMs,
        acked,
      });
    }
  }

  private async postChatMessage(botId: string, message: string): Promise<void> {
    this.store.recordSentMessage(botId, message, this.now());
    await this.deps.recallClient.sendChatMessage(botId, { to: "everyone", message });
  }

  private async speakBestEffort(botId: string, sessionId: string, reply: string): Promise<void> {
    const { speechSynthesizer, recallClient, logger } = this.deps;
    if (!speechSynthesizer) return;
    const spoken = toSpokenText(reply);
    if (spoken === "") return;
    try {
      const speech = await speechSynthesizer.synthesize(spoken);
      const wait = (this.speakingUntil.get(botId) ?? 0) - this.now().getTime();
      // Recall does not document what happens to a clip sent while another plays, so clips never overlap.
      if (wait > 0) await this.sleep(Math.min(wait, MAX_SPEECH_WAIT_MS));
      await recallClient.outputAudio(botId, speech.base64);
      this.speakingUntil.set(botId, this.now().getTime() + speech.durationMs);
    } catch (error) {
      logger.warn("Failed to speak a meeting agent reply", {
        botId,
        sessionId,
        kind: getSpeechSynthesisErrorKind(error) ?? getErrorKind(error),
      });
    }
  }

  private async postBestEffort(botId: string, sessionId: string, message: string): Promise<boolean> {
    try {
      await this.postChatMessage(botId, message);
      return true;
    } catch (error) {
      this.deps.logger.warn("Failed to post a meeting agent notice", {
        botId,
        sessionId,
        kind: getErrorKind(error),
      });
      return false;
    }
  }
}
