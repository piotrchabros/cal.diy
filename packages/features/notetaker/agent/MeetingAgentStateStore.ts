import type { MeetingAgentLine } from "./IMeetingAgent";

export type MeetingAgentCommandLimits = { perMinute: number; perMeeting: number };

type MeetingAgentStateStoreOptions = {
  maxBots?: number;
  idleTtlMs?: number;
  maxLines?: number;
  maxLineChars?: number;
};

type TimedText = { text: string; at: number };

type BotState = {
  lastSeenAt: number;
  deliveryIds: Set<string>;
  lines: MeetingAgentLine[];
  pendingTriggers: Map<number, number>;
  lastCommands: Map<string, TimedText>;
  commandCount: number;
  commandTimes: number[];
  limitNoticeSent: boolean;
  sentMessages: TimedText[];
};

const DEFAULT_MAX_BOTS = 500;
const DEFAULT_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_LINES = 20;
const DEFAULT_MAX_LINE_CHARS = 500;
const MAX_DELIVERY_IDS = 200;
const MAX_SENT_MESSAGES = 50;
const DEFAULT_PENDING_TRIGGER_WINDOW_MS = 15 * 1000;
const DEFAULT_DUPLICATE_COMMAND_WINDOW_MS = 10 * 1000;
const COMMAND_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_SENT_MESSAGE_WINDOW_MS = 2 * 60 * 1000;

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Production runs without Redis, so agent state lives in process memory: it is best effort,
// lost on restart and not shared between instances, which is acceptable for de-duplication and rate limiting.
export class MeetingAgentStateStore {
  private readonly bots = new Map<string, BotState>();
  private readonly maxBots: number;
  private readonly idleTtlMs: number;
  private readonly maxLines: number;
  private readonly maxLineChars: number;
  private latestNowMs = 0;

  constructor(options: MeetingAgentStateStoreOptions = {}) {
    this.maxBots = options.maxBots ?? DEFAULT_MAX_BOTS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  }

  markDelivery(botId: string, deliveryId: string, now: Date): boolean {
    const state = this.touch(botId, now.getTime());
    if (state.deliveryIds.has(deliveryId)) return false;
    state.deliveryIds.add(deliveryId);
    if (state.deliveryIds.size > MAX_DELIVERY_IDS) {
      const oldest = state.deliveryIds.values().next().value;
      if (oldest !== undefined) state.deliveryIds.delete(oldest);
    }
    return true;
  }

  appendLine(botId: string, line: MeetingAgentLine): void {
    const state = this.touch(botId, line.at.getTime());
    const text = line.text.length > this.maxLineChars ? line.text.slice(0, this.maxLineChars) : line.text;
    state.lines.push({ ...line, text });
    if (state.lines.length > this.maxLines) {
      state.lines.splice(0, state.lines.length - this.maxLines);
    }
  }

  getRecentLines(botId: string): MeetingAgentLine[] {
    const state = this.bots.get(botId);
    if (!state) return [];
    return state.lines.slice();
  }

  setPendingTrigger(botId: string, participantId: number, now: Date): void {
    const state = this.touch(botId, now.getTime());
    state.pendingTriggers.set(participantId, now.getTime());
  }

  takePendingTrigger(
    botId: string,
    participantId: number,
    now: Date,
    windowMs: number = DEFAULT_PENDING_TRIGGER_WINDOW_MS
  ): boolean {
    const state = this.touch(botId, now.getTime());
    const setAt = state.pendingTriggers.get(participantId);
    if (setAt === undefined) return false;
    state.pendingTriggers.delete(participantId);
    return now.getTime() - setAt <= windowMs;
  }

  isDuplicateCommand(
    botId: string,
    participantKey: string,
    command: string,
    now: Date,
    windowMs: number = DEFAULT_DUPLICATE_COMMAND_WINDOW_MS
  ): boolean {
    const state = this.touch(botId, now.getTime());
    const text = normalise(command);
    const previous = state.lastCommands.get(participantKey);
    state.lastCommands.set(participantKey, { text, at: now.getTime() });
    if (!previous) return false;
    return previous.text === text && now.getTime() - previous.at <= windowMs;
  }

  tryConsumeCommand(
    botId: string,
    now: Date,
    limits: MeetingAgentCommandLimits
  ): "OK" | "MINUTE_LIMIT" | "MEETING_LIMIT" {
    const nowMs = now.getTime();
    const state = this.touch(botId, nowMs);
    state.commandTimes = state.commandTimes.filter((at) => nowMs - at < COMMAND_RATE_WINDOW_MS);
    if (state.commandCount >= limits.perMeeting) return "MEETING_LIMIT";
    if (state.commandTimes.length >= limits.perMinute) return "MINUTE_LIMIT";
    state.commandTimes.push(nowMs);
    state.commandCount += 1;
    return "OK";
  }

  markLimitNoticeSent(botId: string): boolean {
    const state = this.touch(botId);
    if (state.limitNoticeSent) return false;
    state.limitNoticeSent = true;
    return true;
  }

  recordSentMessage(botId: string, text: string, now: Date): void {
    const state = this.touch(botId, now.getTime());
    state.sentMessages.push({ text: normalise(text), at: now.getTime() });
    if (state.sentMessages.length > MAX_SENT_MESSAGES) {
      state.sentMessages.splice(0, state.sentMessages.length - MAX_SENT_MESSAGES);
    }
  }

  wasSentByBot(
    botId: string,
    text: string,
    now: Date,
    windowMs: number = DEFAULT_SENT_MESSAGE_WINDOW_MS
  ): boolean {
    const state = this.bots.get(botId);
    if (!state) return false;
    const nowMs = now.getTime();
    const normalised = normalise(text);
    return state.sentMessages.some((sent) => sent.text === normalised && nowMs - sent.at <= windowMs);
  }

  // Without `nowMs` the entry is still moved to the most recent position, but idleness is not checked.
  private touch(botId: string, nowMs?: number): BotState {
    if (nowMs !== undefined) {
      this.latestNowMs = Math.max(this.latestNowMs, nowMs);
      this.evictIdle(nowMs);
    }

    let state = this.bots.get(botId);
    if (state) {
      this.bots.delete(botId);
    } else {
      state = this.createState(nowMs ?? this.latestNowMs);
    }
    if (nowMs !== undefined && nowMs > state.lastSeenAt) state.lastSeenAt = nowMs;
    this.bots.set(botId, state);

    while (this.bots.size > this.maxBots) {
      const oldest = this.bots.keys().next().value;
      if (oldest === undefined) break;
      this.bots.delete(oldest);
    }
    return state;
  }

  // Entries are kept in touch order, so idle ones accumulate at the front of the map.
  private evictIdle(nowMs: number): void {
    while (this.bots.size > 0) {
      const oldest = this.bots.entries().next().value;
      if (oldest === undefined) return;
      const [botId, state] = oldest;
      if (nowMs - state.lastSeenAt <= this.idleTtlMs) return;
      this.bots.delete(botId);
    }
  }

  private createState(nowMs: number): BotState {
    return {
      lastSeenAt: nowMs,
      deliveryIds: new Set(),
      lines: [],
      pendingTriggers: new Map(),
      lastCommands: new Map(),
      commandCount: 0,
      commandTimes: [],
      limitNoticeSent: false,
      sentMessages: [],
    };
  }
}
