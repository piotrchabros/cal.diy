// Manual smoke test of the real SonioxRealtimeProvider, driven the way the meeting runner drives it.
//
// Usage: yarn workspace @calcom/notetaker-bot tsx scripts/soniox-smoke.ts <path-to-raw-16kHz-s16le-mono-file> [--speed <n>] [--idle-ms <n>] [--trace]
// The key is read from SONIOX_API_KEY (loaded from apps/notetaker-bot/.env when present); SONIOX_WS_URL and
// SONIOX_MODEL override the provider defaults, as in config.ts. It only reads the audio file and writes nothing to disk.
//
// --speed n   sends one 128 ms frame every 128 / n ms (default 1 = real time). Anything but 1 departs from the bot,
//             which receives audio in real time; the pump clock is scaled by n so no silence is padded because of it.
// --idle-ms n waits n ms after start() resolves before the first frame, to see whether the connection survives
//             Soniox's 20 s idle limit.
// --trace     prints one line per WebSocket text message in either direction, and the close code, to stderr.
//             It never prints the upgrade headers (they carry the key) nor a server error_message.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { RawData } from "ws";
import { WebSocket } from "ws";
import type { Pcm16Frame } from "../src/audio/AudioFrame";
import { AUDIO_SAMPLE_RATE_HZ, getFrameDurationMs } from "../src/audio/AudioFrame";
import { createLogger } from "../src/logger";
import { AudioFramePump } from "../src/runner/AudioFramePump";
import { STT_FLUSH_TIMEOUT_MS } from "../src/runner/MeetingRunner";
import { SonioxRealtimeProvider } from "../src/stt/SonioxRealtimeProvider";
import type { SttUtterance } from "../src/stt/SpeechToTextProvider";
import {
  SONIOX_DEFAULT_MODEL,
  SONIOX_DEFAULT_WS_URL,
  SONIOX_END_OF_AUDIO_MESSAGE,
  SONIOX_KEEPALIVE_MESSAGE,
} from "../src/stt/sonioxProtocol";

const FRAME_SAMPLES = 2048;
const CLOSE_WAIT_LIMIT_MS = 15000;
// Same value as the provider's own default socket, which the traced socket replaces.
const HANDSHAKE_TIMEOUT_MS = 10000;
const TRACE_SERVER_CLOSE_WAIT_MS = 1000;

type SmokeOptions = { audioPath: string; speed: number; idleMs: number; trace: boolean };
type SendData = Parameters<WebSocket["send"]>[0];
type SendOptions = { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean };
type SendCallback = (err?: Error) => void;

function parseArgs(argv: string[]): SmokeOptions | Error {
  let audioPath: string | null = null;
  let speed = 1;
  let idleMs = 0;
  let trace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--trace") {
      trace = true;
      continue;
    }
    if (arg === "--speed" || arg === "--idle-ms") {
      const value = Number(argv[index + 1]);
      index += 1;
      if (!Number.isFinite(value)) return new Error(`${arg} needs a number`);
      if (arg === "--speed") {
        if (value <= 0) return new Error("--speed must be greater than 0");
        speed = value;
      } else {
        if (value < 0) return new Error("--idle-ms must not be negative");
        idleMs = value;
      }
      continue;
    }
    if (arg.startsWith("--") || audioPath !== null) return new Error(`Unexpected argument: ${arg}`);
    audioPath = arg;
  }
  if (audioPath === null) return new Error("Missing the path to a raw 16 kHz s16le mono file");
  return { audioPath, speed, idleMs, trace };
}

function loadEnvFile(): void {
  try {
    // loadEnvFile never overrides variables that are already set.
    process.loadEnvFile(path.resolve(__dirname, "../.env"));
  } catch {
    // A missing env file is fine: the key may come from the environment.
  }
}

function sliceFrames(audioPath: string): Pcm16Frame[] {
  const bytes = readFileSync(audioPath);
  // An odd trailing byte cannot form a sample. Copying also guarantees the 2-byte alignment Int16Array needs.
  const evenLength = bytes.byteLength - (bytes.byteLength % 2);
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + evenLength));
  const frames: Pcm16Frame[] = [];
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    frames.push({ samples: samples.slice(offset, offset + FRAME_SAMPLES) });
  }
  return frames;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatField(value: string | null): string {
  return value === null ? "-" : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeToken(token: unknown): string {
  if (!isRecord(token)) return "?";
  const finality = token.is_final === true ? "F" : "N";
  return `${JSON.stringify(token.text)}/${finality}/${token.start_ms ?? "-"}-${token.end_ms ?? "-"}/s${token.speaker ?? "-"}/${token.language ?? "-"}`;
}

// Whitelists what is printed: error_message can echo request content, so it is never read.
function describeServerText(text: string): string {
  const payload = parseJson(text);
  if (!isRecord(payload)) return `unparsable text, ${text.length} chars`;
  const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
  const parts = [`tokens=${tokens.length}`];
  for (const name of ["final_audio_proc_ms", "total_audio_proc_ms", "finished", "error_code", "error_type"]) {
    const value = payload[name];
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      parts.push(`${name}=${value}`);
    }
  }
  return [...parts, ...tokens.map(describeToken)].join(" ");
}

function describeClientText(text: string): string {
  if (text === SONIOX_END_OF_AUDIO_MESSAGE) return "end-of-audio (empty text frame)";
  if (text === SONIOX_KEEPALIVE_MESSAGE) return "keepalive";
  const payload = parseJson(text);
  if (isRecord(payload) && typeof payload.model === "string") {
    return `start fields=[${Object.keys(payload).join(",")}] model=${payload.model}`;
  }
  return `other text, ${text.length} chars`;
}

// The headers are handed straight to the socket and never reach the trace: they carry the key.
function createTracedSocket(
  url: string,
  headers: Record<string, string>,
  sinceStart: () => number,
  onClosed: (closed: Promise<void>) => void
): WebSocket {
  const socket = new WebSocket(url, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
  const trace = (line: string): void => {
    console.error(`trace +${sinceStart()}ms ${line}`);
  };
  let binarySent = 0;

  const send = socket.send.bind(socket);
  socket.send = (data: SendData, second?: SendOptions | SendCallback, third?: SendCallback): void => {
    if (typeof data === "string") {
      trace(`C> ${describeClientText(data)} (after ${binarySent} binary frames)`);
    } else {
      binarySent += 1;
    }
    if (second === undefined) send(data);
    else if (typeof second === "function") send(data, second);
    else send(data, second, third);
  };

  // Registered before the provider's listeners, so each line precedes what the provider does with the message.
  socket.on("open", () => trace("open"));
  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      trace("S> binary message");
      return;
    }
    let buffer: Buffer;
    if (Buffer.isBuffer(data)) buffer = data;
    else if (Array.isArray(data)) buffer = Buffer.concat(data);
    else buffer = Buffer.from(data);
    trace(`S> ${describeServerText(buffer.toString("utf8"))}`);
  });
  // The error itself can quote the URL, so only the fact is printed.
  socket.on("error", () => trace("socket error"));
  onClosed(
    new Promise<void>((resolve) => {
      socket.on("close", (code: number) => {
        trace(`close code=${code} (after ${binarySent} binary frames)`);
        resolve();
      });
    })
  );

  // The provider terminates the socket as soon as it has the finished response, which would hide the server's own
  // close code behind a local 1006. By then the provider no longer listens, so holding the terminate back until the
  // server has closed (or a short wait has passed) changes nothing it can see.
  const terminate = socket.terminate.bind(socket);
  socket.terminate = (): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      terminate();
      return;
    }
    trace("provider called terminate(); waiting for the server to close first");
    const timer = setTimeout(() => {
      trace("server did not close in time; terminating locally");
      terminate();
    }, TRACE_SERVER_CLOSE_WAIT_MS);
    socket.once("close", () => clearTimeout(timer));
  };
  return socket;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options instanceof Error) {
    console.error(options.message);
    console.error(
      "Usage: soniox-smoke.ts <path-to-raw-16kHz-s16le-mono-file> [--speed <n>] [--idle-ms <n>] [--trace]"
    );
    return 2;
  }

  loadEnvFile();
  const apiKey = process.env.SONIOX_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    console.error(
      "SONIOX_API_KEY is missing or empty; set it in the environment or in apps/notetaker-bot/.env"
    );
    return 2;
  }
  const url = process.env.SONIOX_WS_URL?.trim() || undefined;
  const model = process.env.SONIOX_MODEL?.trim() || undefined;

  let frames: Pcm16Frame[];
  try {
    frames = sliceFrames(options.audioPath);
  } catch {
    console.error(`Unable to read the audio file at ${options.audioPath}`);
    return 2;
  }
  if (frames.length === 0) {
    console.error("The audio file holds no complete 16-bit sample");
    return 2;
  }

  console.log(`model: ${model ?? SONIOX_DEFAULT_MODEL}`);
  console.log(`url: ${url ?? SONIOX_DEFAULT_WS_URL}`);
  console.log(
    `frames: ${frames.length} x ${FRAME_SAMPLES} samples, speed ${options.speed}, idle ${options.idleMs} ms`
  );

  // The logger writes to stderr only and the provider never passes the key to it.
  const logger = createLogger({ level: "debug" });
  const startedAt = Date.now();
  const sinceStart = (): number => Date.now() - startedAt;
  const tracedSocketsClosed: Promise<void>[] = [];
  const provider = new SonioxRealtimeProvider({
    apiKey,
    url,
    model,
    logger,
    createSocket: options.trace
      ? (socketUrl, headers) =>
          createTracedSocket(socketUrl, headers, sinceStart, (closed) => tracedSocketsClosed.push(closed))
      : undefined,
  });
  // Mirrors the runner: the pump clock is 0 before start(), so the connect time is padded with silence.
  // The idle wait resets it, otherwise the pump would fill the idle period with silence and the socket would not be idle.
  let clockOrigin = startedAt;
  const pump = new AudioFramePump({
    sink: (frame) => provider.pushAudio(frame),
    nowMs: () => (Date.now() - clockOrigin) * options.speed,
  });

  const utterances: SttUtterance[] = [];
  const errors: Error[] = [];
  const onUtterance = (utterance: SttUtterance): void => {
    utterances.push(utterance);
    console.log(
      [
        `+${sinceStart()}ms`,
        `start=${utterance.startMs}`,
        `end=${utterance.endMs}`,
        `speaker=${formatField(utterance.diarizationLabel)}`,
        `lang=${formatField(utterance.language)}`,
        JSON.stringify(utterance.text),
      ].join("\t")
    );
  };
  const onError = (error: Error): void => {
    errors.push(error);
    console.log(`+${sinceStart()}ms\tonError: ${error.message}`);
  };

  let startMs: number | null = null;
  try {
    await provider.start({ onUtterance, onError });
    startMs = sinceStart();
  } catch (error) {
    console.error(`start() failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }

  if (options.idleMs > 0) {
    await sleep(options.idleMs);
    clockOrigin = Date.now();
  }
  pump.start();

  const frameIntervalMs = getFrameDurationMs({ samples: new Int16Array(FRAME_SAMPLES) }) / options.speed;
  const firstFrameAt = Date.now();
  let sentMs = 0;
  let pushedFrames = 0;
  for (const [index, frame] of frames.entries()) {
    const waitMs = firstFrameAt + index * frameIntervalMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    if (errors.length > 0) break;
    pump.push(frame);
    sentMs += getFrameDurationMs(frame);
    pushedFrames += 1;
  }
  pump.stop();

  const closeCalledAt = Date.now();
  let closeSettled = false;
  const closing = provider.close().then(
    () => {
      closeSettled = true;
    },
    (error: unknown) => {
      closeSettled = true;
      errors.push(error instanceof Error ? error : new Error("close() rejected"));
    }
  );
  await Promise.race([closing, sleep(CLOSE_WAIT_LIMIT_MS)]);
  const closeMs = Date.now() - closeCalledAt;
  // Lets the trace print the close code before the process exits; empty without --trace.
  await Promise.race([Promise.all(tracedSocketsClosed), sleep(2 * TRACE_SERVER_CLOSE_WAIT_MS)]);

  const speakers = new Set(utterances.map((utterance) => formatField(utterance.diarizationLabel)));
  const languages = new Set(utterances.map((utterance) => formatField(utterance.language)));
  console.log("--- summary ---");
  console.log(
    `audio sent: ${Math.round(sentMs)} ms in ${pushedFrames} of ${frames.length} frames (${AUDIO_SAMPLE_RATE_HZ} Hz mono)`
  );
  console.log(`start() resolved after: ${startMs} ms`);
  console.log(
    closeSettled
      ? `close() resolved after: ${closeMs} ms (${closeMs <= STT_FLUSH_TIMEOUT_MS ? "within" : "OVER"} the runner's ${STT_FLUSH_TIMEOUT_MS} ms budget)`
      : `close() did not resolve within ${CLOSE_WAIT_LIMIT_MS} ms (OVER the runner's ${STT_FLUSH_TIMEOUT_MS} ms budget)`
  );
  console.log(`utterances: ${utterances.length}`);
  console.log(`distinct speaker labels: ${speakers.size} [${[...speakers].join(", ")}]`);
  console.log(`distinct languages: ${languages.size} [${[...languages].join(", ")}]`);
  console.log(`onError calls: ${errors.length}`);

  return errors.length === 0 && utterances.length > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error("soniox-smoke failed unexpectedly");
    process.exit(1);
  }
);
