// UNVERIFIED AGAINST THE REAL SERVICE (Soniox realtime API): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/smoke-test-google-meet.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import type { RawData } from "ws";
import { WebSocket } from "ws";
import type { Pcm16Frame } from "../audio/AudioFrame";
import { getFrameDurationMs } from "../audio/AudioFrame";
import type { Logger } from "../logger";
import type { SpeechToTextProvider, SttHandlers, SttUtterance } from "./SpeechToTextProvider";
import type { SonioxToken } from "./sonioxProtocol";
import {
  buildSonioxStartMessage,
  SONIOX_DEFAULT_MODEL,
  SONIOX_DEFAULT_WS_URL,
  SONIOX_END_OF_AUDIO_MESSAGE,
  SONIOX_ENDPOINT_TOKEN,
  sonioxResponseSchema,
} from "./sonioxProtocol";

const CONNECT_TIMEOUT_MS = 10000;
// Deliberately below the runner's 3000 ms flush timeout, so the last utterances land before the
// runner gives up waiting for close().
const CLOSE_FLUSH_TIMEOUT_MS = 2000;
const DEFAULT_MAX_UTTERANCE_MS = 30000;
const DEFAULT_MAX_TOKEN_GAP_MS = 1500;

const START_FAILURE_MESSAGE =
  "Unable to start Soniox realtime transcription: the connection could not be opened";
const SECOND_LOSS_MESSAGE = "Soniox realtime connection was lost twice; transcription has stopped";

type ProviderState = "idle" | "connecting" | "open" | "reconnecting" | "closing" | "closed";

type PendingUtterance = {
  startMs: number;
  endMs: number;
  parts: string[];
  speaker: string | null;
  language: string | null;
};

function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export class SonioxRealtimeProvider implements SpeechToTextProvider {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly logger: Logger;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly maxUtteranceMs: number;
  private readonly maxTokenGapMs: number;

  private handlers: SttHandlers | null = null;
  private socket: WebSocket | null = null;
  private state: ProviderState = "idle";
  // Unrounded on purpose: rounding per frame would drift over a long meeting.
  private pushedAudioMs = 0;
  private connectionOffsetMs = 0;
  private reconnectUsed = false;
  private pending: PendingUtterance | null = null;
  private lastEndMs = 0;
  private closePromise: Promise<void> | null = null;
  private startSettlers: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private finishFlushWait: (() => void) | null = null;

  constructor(deps: {
    apiKey: string;
    url?: string;
    model?: string;
    logger: Logger;
    createSocket?: (url: string) => WebSocket;
    maxUtteranceMs?: number;
    maxTokenGapMs?: number;
  }) {
    this.apiKey = deps.apiKey;
    this.url = deps.url ?? SONIOX_DEFAULT_WS_URL;
    this.model = deps.model ?? SONIOX_DEFAULT_MODEL;
    this.logger = deps.logger;
    // No headers and no query string: the key travels only in the first message.
    this.createSocket =
      deps.createSocket ?? ((url) => new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS }));
    this.maxUtteranceMs = deps.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS;
    this.maxTokenGapMs = deps.maxTokenGapMs ?? DEFAULT_MAX_TOKEN_GAP_MS;
  }

  start(handlers: SttHandlers): Promise<void> {
    if (this.state !== "idle") {
      return Promise.reject(
        new Error(`Unable to start Soniox realtime transcription: the provider is already ${this.state}`)
      );
    }

    this.handlers = handlers;
    this.state = "connecting";
    return new Promise<void>((resolve, reject) => {
      this.startSettlers = { resolve, reject };
      try {
        this.openConnection();
      } catch {
        // The underlying error can quote the URL, so it is dropped rather than forwarded.
        this.state = "closed";
        this.rejectStart();
      }
    });
  }

  pushAudio(frame: Pcm16Frame): void {
    if (this.state === "idle" || this.state === "closing" || this.state === "closed") return;

    // Counted even while there is no open socket, so the offset of the next connection stays on
    // the audio clock.
    this.pushedAudioMs += getFrameDurationMs(frame);

    const socket = this.socket;
    if (this.state !== "open" || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (frame.samples.byteLength === 0) return;

    // PCM16 little-endian is the host byte order on every supported platform, so the samples go
    // out as they are, without a copy.
    socket.send(Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    const socket = this.socket;

    if (this.state === "idle" || this.state === "closed") {
      this.state = "closed";
      return;
    }

    if (this.state !== "open" || !socket) {
      this.state = "closing";
      socket?.terminate();
      this.state = "closed";
      // Without this a start() still waiting for the socket would never settle.
      this.rejectStart();
      return;
    }

    this.state = "closing";
    socket.send(SONIOX_END_OF_AUDIO_MESSAGE);

    // Messages keep being processed during this wait, so tokens finalised by the end-of-audio
    // signal are emitted before close() resolves.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS);
      this.finishFlushWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.finishFlushWait = null;

    this.flushPending();
    socket.terminate();
    this.state = "closed";
  }

  private openConnection(): void {
    const socket = this.createSocket(this.url);
    this.socket = socket;

    socket.on("open", () => this.handleOpen(socket));
    socket.on("message", (data: RawData, isBinary: boolean) => this.handleMessage(socket, data, isBinary));
    // Must exist: an unhandled "error" event would crash the process. The "close" event that
    // always follows decides what happened.
    socket.on("error", () => {
      this.logger.warn("soniox socket error", { phase: this.state });
    });
    socket.on("close", () => this.handleSocketClose(socket));
  }

  private handleOpen(socket: WebSocket): void {
    if (socket !== this.socket || this.state === "closing" || this.state === "closed") {
      socket.terminate();
      return;
    }

    socket.send(buildSonioxStartMessage({ apiKey: this.apiKey, model: this.model }));
    // The service counts from zero on every connection, so later positions are shifted by the
    // audio already pushed.
    this.connectionOffsetMs = Math.round(this.pushedAudioMs);
    this.state = "open";

    this.startSettlers?.resolve();
    this.startSettlers = null;
  }

  private handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (socket !== this.socket || this.state === "closed") return;
    if (isBinary) return;

    let payload: unknown;
    try {
      payload = JSON.parse(rawDataToText(data));
    } catch {
      this.logger.warn("soniox message ignored");
      return;
    }

    const parsed = sonioxResponseSchema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn("soniox message ignored");
      return;
    }
    const response = parsed.data;

    if (response.error_code !== undefined) {
      // The error message can echo request content, so only the code is logged. The service
      // closes the socket afterwards and the close path takes over.
      this.logger.error("soniox error response", { errorCode: response.error_code });
    }

    for (const token of response.tokens ?? []) {
      this.handleToken(token);
    }

    if (response.finished !== true) return;
    this.flushPending();
    if (this.state === "closing") this.finishFlushWait?.();
  }

  private handleToken(token: SonioxToken): void {
    if (token.is_final !== true) return;

    if (token.text === SONIOX_ENDPOINT_TOKEN) {
      this.flushPending();
      return;
    }

    const tokenStart =
      token.start_ms !== undefined
        ? this.connectionOffsetMs + Math.round(token.start_ms)
        : (this.pending?.endMs ?? this.lastEndMs);
    const tokenEnd = Math.max(
      token.end_ms !== undefined ? this.connectionOffsetMs + Math.round(token.end_ms) : tokenStart,
      tokenStart
    );
    const speaker = token.speaker ?? null;
    const language = token.language ?? null;

    const open = this.pending;
    if (
      open &&
      (open.speaker !== speaker ||
        open.language !== language ||
        tokenStart - open.endMs > this.maxTokenGapMs ||
        tokenEnd - open.startMs > this.maxUtteranceMs)
    ) {
      this.flushPending();
    }

    if (!this.pending) {
      this.pending = { startMs: tokenStart, endMs: tokenEnd, parts: [token.text], speaker, language };
      return;
    }

    // Tokens are sub-word pieces carrying their own leading spaces, so they are joined verbatim.
    this.pending.parts.push(token.text);
    this.pending.endMs = tokenEnd;
  }

  private flushPending(): void {
    const pending = this.pending;
    if (!pending) return;

    this.pending = null;
    this.lastEndMs = pending.endMs;

    const text = pending.parts.join("").trim();
    if (text === "") return;

    const utterance: SttUtterance = {
      startMs: pending.startMs,
      endMs: pending.endMs,
      text,
      language: pending.language,
      diarizationLabel: pending.speaker,
    };
    try {
      this.handlers?.onUtterance(utterance);
    } catch {
      // A throwing consumer must not take the socket listener down with it.
      this.logger.error("soniox utterance handler failed");
    }
  }

  private handleSocketClose(socket: WebSocket): void {
    if (socket !== this.socket) return;

    if (this.state === "closing" || this.state === "closed") {
      this.finishFlushWait?.();
      return;
    }

    if (this.state === "connecting") {
      this.state = "closed";
      this.socket = null;
      this.rejectStart();
      return;
    }

    this.flushPending();

    if (!this.reconnectUsed) {
      this.reconnectUsed = true;
      this.logger.warn("soniox connection lost, reconnecting once", { reconnect: true });
      this.state = "reconnecting";
      try {
        this.openConnection();
        return;
      } catch {
        this.logger.warn("soniox socket error", { phase: this.state });
      }
    }

    this.state = "closed";
    this.socket = null;
    this.logger.error("soniox connection lost twice, transcription stopped", { reconnect: false });
    try {
      this.handlers?.onError(new Error(SECOND_LOSS_MESSAGE));
    } catch {
      this.logger.error("soniox error handler failed");
    }
  }

  private rejectStart(): void {
    const settlers = this.startSettlers;
    this.startSettlers = null;
    settlers?.reject(new Error(START_FAILURE_MESSAGE));
  }
}
