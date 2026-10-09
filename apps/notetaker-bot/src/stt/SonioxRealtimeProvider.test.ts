// @vitest-environment node
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { Pcm16Frame } from "../audio/AudioFrame";
import { AUDIO_SAMPLE_RATE_HZ, createSilenceFrame } from "../audio/AudioFrame";
import { createLogger } from "../logger";
import { SonioxRealtimeProvider } from "./SonioxRealtimeProvider";
import type { SttUtterance } from "./SpeechToTextProvider";
import type { SonioxResponse } from "./sonioxProtocol";
import {
  buildSonioxStartMessage,
  SONIOX_DEFAULT_MODEL,
  SONIOX_ENDPOINT_TOKEN,
  sonioxResponseSchema,
} from "./sonioxProtocol";

const API_KEY = "soniox-test-key-not-real";
const SECOND_LOSS_MESSAGE = "Soniox realtime connection was lost twice; transcription has stopped";

type StubConnection = {
  socket: WebSocket;
  requestUrl: string | undefined;
  headers: IncomingHttpHeaders;
  texts: string[];
  binaries: Buffer[];
  // Arrival order of messages, true for binary, so a test can assert the first message is text.
  order: boolean[];
  closed: boolean;
  send(response: SonioxResponse): void;
  sendRaw(text: string): void;
  drop(): void;
  closeGracefully(): void;
};

type StubOptions = {
  // Defaults to answering the end-of-audio frame with { finished: true } so close() is quick.
  onEndOfAudio?: (connection: StubConnection) => void;
};

type Stub = {
  url: string;
  connections: StubConnection[];
  close(): Promise<void>;
};

async function startStubSoniox(options: StubOptions = {}): Promise<Stub> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("The stub server did not report a port");
  }

  const connections: StubConnection[] = [];
  const onEndOfAudio =
    options.onEndOfAudio ?? ((connection: StubConnection) => connection.send({ finished: true }));

  server.on("connection", (socket, request) => {
    const connection: StubConnection = {
      socket,
      requestUrl: request.url,
      headers: request.headers,
      texts: [],
      binaries: [],
      order: [],
      closed: false,
      send: (response) => socket.send(JSON.stringify(response)),
      sendRaw: (text) => socket.send(text),
      drop: () => socket.terminate(),
      closeGracefully: () => socket.close(),
    };
    socket.on("close", () => {
      connection.closed = true;
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      let buffer: Buffer;
      if (Buffer.isBuffer(data)) buffer = data;
      else if (Array.isArray(data)) buffer = Buffer.concat(data);
      else buffer = Buffer.from(data);
      connection.order.push(isBinary);
      if (isBinary) {
        connection.binaries.push(buffer);
        return;
      }
      const text = buffer.toString("utf8");
      connection.texts.push(text);
      if (text === "") onEndOfAudio(connection);
    });
    connections.push(connection);
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    connections,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function token(
  text: string,
  startMs: number,
  endMs: number,
  extra: { speaker?: string; language?: string; is_final?: boolean } = {}
): NonNullable<SonioxResponse["tokens"]>[number] {
  return { text, start_ms: startMs, end_ms: endMs, is_final: true, ...extra };
}

const endpoint = { text: SONIOX_ENDPOINT_TOKEN, is_final: true };

const stubs: Stub[] = [];
const providers: SonioxRealtimeProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
  for (const stub of stubs.splice(0)) await stub.close();
});

async function setup(
  stubOptions: StubOptions = {},
  providerOptions: { model?: string; maxUtteranceMs?: number; maxTokenGapMs?: number } = {}
) {
  const stub = await startStubSoniox(stubOptions);
  stubs.push(stub);
  const utterances: SttUtterance[] = [];
  const errors: Error[] = [];
  const lines: string[] = [];
  const provider = new SonioxRealtimeProvider({
    apiKey: API_KEY,
    url: stub.url,
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    ...providerOptions,
  });
  providers.push(provider);
  const handlers = {
    onUtterance: (utterance: SttUtterance) => utterances.push(utterance),
    onError: (error: Error) => errors.push(error),
  };
  return { stub, provider, handlers, utterances, errors, lines };
}

async function setupStarted(
  stubOptions: StubOptions = {},
  providerOptions: { model?: string; maxUtteranceMs?: number; maxTokenGapMs?: number } = {}
) {
  const context = await setup(stubOptions, providerOptions);
  await context.provider.start(context.handlers);
  await vi.waitFor(() => expect(context.stub.connections).toHaveLength(1));
  return { ...context, connection: context.stub.connections[0] as StubConnection };
}

describe("sonioxProtocol", () => {
  it("builds the start message with the fixed audio and feature settings", () => {
    const parsed: unknown = JSON.parse(buildSonioxStartMessage({ apiKey: API_KEY, model: "some-model" }));
    expect(parsed).toEqual({
      api_key: API_KEY,
      model: "some-model",
      audio_format: "pcm_s16le",
      sample_rate: AUDIO_SAMPLE_RATE_HZ,
      num_channels: 1,
      enable_speaker_diarization: true,
      enable_language_identification: true,
      enable_endpoint_detection: true,
    });
  });

  it("accepts token, finished and error responses and rejects a token without text", () => {
    expect(
      sonioxResponseSchema.safeParse({ tokens: [{ text: "a", is_final: true, confidence: 0.9 }], extra: 1 })
        .success
    ).toBe(true);
    expect(sonioxResponseSchema.safeParse({ finished: true }).success).toBe(true);
    expect(sonioxResponseSchema.safeParse({ error_code: 401, error_message: "nope" }).success).toBe(true);
    expect(sonioxResponseSchema.safeParse({ tokens: [{ start_ms: 1 }] }).success).toBe(false);
  });
});

describe("SonioxRealtimeProvider", () => {
  describe("start", () => {
    it("sends the start message first as text and keeps the key out of the url and headers", async () => {
      const { connection } = await setupStarted();
      await vi.waitFor(() => expect(connection.order.length).toBeGreaterThan(0));
      expect(connection.order[0]).toBe(false);
      expect(connection.texts[0]).toBe(
        buildSonioxStartMessage({ apiKey: API_KEY, model: SONIOX_DEFAULT_MODEL })
      );
      expect(connection.requestUrl ?? "").not.toContain(API_KEY);
      expect(JSON.stringify(connection.headers)).not.toContain(API_KEY);
    });

    it("uses an injected model", async () => {
      const { connection } = await setupStarted({}, { model: "custom-model" });
      await vi.waitFor(() => expect(connection.texts).toHaveLength(1));
      expect(connection.texts[0]).toBe(buildSonioxStartMessage({ apiKey: API_KEY, model: "custom-model" }));
    });

    it("rejects without leaking the key or url when nothing listens", async () => {
      const closedStub = await startStubSoniox();
      const deadUrl = closedStub.url;
      await closedStub.close();
      const provider = new SonioxRealtimeProvider({
        apiKey: API_KEY,
        url: deadUrl,
        logger: createLogger({ level: "silent", write: () => {} }),
      });
      providers.push(provider);

      const failure = await provider.start({ onUtterance: () => {}, onError: () => {} }).then(
        () => null,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) return;
      expect(failure.message).toBe(
        "Unable to start Soniox realtime transcription: the connection could not be opened"
      );
      expect(failure.message).not.toContain(API_KEY);
      expect(failure.message).not.toContain(deadUrl);
    });
  });

  describe("pushAudio", () => {
    it("sends one little-endian binary message per frame in push order", async () => {
      const { provider, connection } = await setupStarted();
      const handBuilt: Pcm16Frame = { samples: Int16Array.from([1, -2, 300]) };
      const silence = createSilenceFrame(100);

      provider.pushAudio(handBuilt);
      provider.pushAudio(silence);
      provider.pushAudio({ samples: new Int16Array(0) });

      await vi.waitFor(() => expect(connection.binaries).toHaveLength(2));
      const first = connection.binaries[0] as Buffer;
      const second = connection.binaries[1] as Buffer;
      expect(first.length).toBe(6);
      expect([first.readInt16LE(0), first.readInt16LE(2), first.readInt16LE(4)]).toEqual([1, -2, 300]);
      expect(second.length).toBe(silence.samples.length * 2);
      expect(second.length).toBe(3200);
    });

    it("drops audio pushed before start and after close without throwing", async () => {
      const { stub, provider, handlers } = await setup();
      expect(() => provider.pushAudio(createSilenceFrame(100))).not.toThrow();

      await provider.start(handlers);
      await vi.waitFor(() => expect(stub.connections).toHaveLength(1));
      await provider.close();
      expect(() => provider.pushAudio(createSilenceFrame(100))).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stub.connections.flatMap((connection) => connection.binaries)).toHaveLength(0);
    });
  });

  describe("token grouping", () => {
    it("ignores non-final tokens", async () => {
      const { connection, utterances } = await setupStarted();
      connection.send({ tokens: [token(" draft", 0, 100, { is_final: false }), endpoint] });
      connection.send({ tokens: [token(" real", 200, 300), endpoint] });

      await vi.waitFor(() => expect(utterances).toHaveLength(1));
      expect(utterances[0]?.text).toBe("real");
    });

    it("joins sub-word tokens into one utterance ended by the endpoint token", async () => {
      const { connection, utterances } = await setupStarted();
      connection.send({
        tokens: [
          token(" Hello", 100, 300, { speaker: "1", language: "en" }),
          token(" wor", 300, 450, { speaker: "1", language: "en" }),
          token("ld", 450, 600, { speaker: "1", language: "en" }),
          endpoint,
        ],
      });

      await vi.waitFor(() => expect(utterances).toHaveLength(1));
      expect(utterances[0]).toEqual({
        startMs: 100,
        endMs: 600,
        text: "Hello world",
        language: "en",
        diarizationLabel: "1",
      });
    });

    it("uses null language and label when the tokens carry none", async () => {
      const { connection, utterances } = await setupStarted();
      connection.send({ tokens: [token(" Plain", 0, 100), endpoint] });

      await vi.waitFor(() => expect(utterances).toHaveLength(1));
      expect(utterances[0]?.language).toBeNull();
      expect(utterances[0]?.diarizationLabel).toBeNull();
    });

    it("splits on a speaker change", async () => {
      const { connection, utterances } = await setupStarted();
      connection.send({
        tokens: [
          token(" one", 0, 100, { speaker: "1" }),
          token(" two", 100, 200, { speaker: "2" }),
          endpoint,
        ],
      });

      await vi.waitFor(() => expect(utterances).toHaveLength(2));
      expect(utterances.map((u) => [u.text, u.diarizationLabel])).toEqual([
        ["one", "1"],
        ["two", "2"],
      ]);
    });

    it("splits on a language change", async () => {
      const { connection, utterances } = await setupStarted();
      connection.send({
        tokens: [
          token(" hi", 0, 100, { language: "en" }),
          token(" cześć", 100, 200, { language: "pl" }),
          endpoint,
        ],
      });

      await vi.waitFor(() => expect(utterances).toHaveLength(2));
      expect(utterances.map((u) => [u.text, u.language])).toEqual([
        ["hi", "en"],
        ["cześć", "pl"],
      ]);
    });

    it("splits when the gap to the next token exceeds maxTokenGapMs", async () => {
      const { connection, utterances } = await setupStarted({}, { maxTokenGapMs: 1500 });
      connection.send({ tokens: [token(" early", 0, 100), token(" late", 2100, 2200), endpoint] });

      await vi.waitFor(() => expect(utterances).toHaveLength(2));
      expect(utterances.map((u) => [u.text, u.startMs, u.endMs])).toEqual([
        ["early", 0, 100],
        ["late", 2100, 2200],
      ]);
    });

    it("splits when an utterance would exceed maxUtteranceMs", async () => {
      const { connection, utterances } = await setupStarted({}, { maxUtteranceMs: 1000 });
      connection.send({
        tokens: [token(" a", 0, 500), token(" b", 500, 900), token(" c", 900, 1300), endpoint],
      });

      await vi.waitFor(() => expect(utterances).toHaveLength(2));
      expect(utterances.map((u) => u.text)).toEqual(["a b", "c"]);
    });

    it("joins tokens of one utterance that arrive in separate messages", async () => {
      const { connection, utterances } = await setupStarted();
      connection.send({ tokens: [token(" split", 0, 100)] });
      connection.send({ tokens: [token(" across", 100, 200)] });
      connection.send({ tokens: [endpoint] });

      await vi.waitFor(() => expect(utterances).toHaveLength(1));
      expect(utterances[0]?.text).toBe("split across");
    });

    it("emits nothing for whitespace-only tokens", async () => {
      const { connection, utterances } = await setupStarted();
      connection.send({ tokens: [token(" ", 0, 50), token("  ", 50, 100), endpoint] });
      connection.send({ tokens: [token(" marker", 200, 300), endpoint] });

      await vi.waitFor(() => expect(utterances).toHaveLength(1));
      expect(utterances[0]?.text).toBe("marker");
    });

    it("rounds fractional positions and never lets the end precede the start", async () => {
      const { connection, utterances } = await setupStarted();
      connection.send({ tokens: [token(" frac", 10.4, 20.6), endpoint] });
      connection.send({ tokens: [token(" back", 500.4, 400), endpoint] });

      await vi.waitFor(() => expect(utterances).toHaveLength(2));
      expect(utterances[0]).toMatchObject({ startMs: 10, endMs: 21 });
      expect(utterances[1]?.startMs).toBe(500);
      expect(utterances[1]?.endMs).toBeGreaterThanOrEqual(500);
      for (const utterance of utterances) {
        expect(Number.isInteger(utterance.startMs)).toBe(true);
        expect(Number.isInteger(utterance.endMs)).toBe(true);
      }
    });

    it("ignores unparsable and schema-invalid messages and keeps working", async () => {
      const { connection, utterances } = await setupStarted();
      connection.sendRaw("this is not json");
      connection.sendRaw(JSON.stringify({ tokens: [{ start_ms: 1 }] }));
      connection.send({ tokens: [token(" still works", 0, 100), endpoint] });

      await vi.waitFor(() => expect(utterances).toHaveLength(1));
      expect(utterances[0]?.text).toBe("still works");
    });
  });

  describe("connection loss", () => {
    it("flushes pending, reconnects once and offsets later positions by the audio already pushed", async () => {
      const { stub, provider, connection, utterances, errors, lines } = await setupStarted();
      for (let index = 0; index < 10; index += 1) provider.pushAudio(createSilenceFrame(100));
      await vi.waitFor(() => expect(connection.binaries).toHaveLength(10));

      // A graceful close keeps the token ahead of the close frame, so the pending token is
      // processed before the loss is noticed.
      connection.send({ tokens: [token(" first", 0, 100)] });
      connection.closeGracefully();

      await vi.waitFor(() => expect(utterances).toHaveLength(1));
      expect(utterances[0]?.text).toBe("first");
      await vi.waitFor(() => expect(stub.connections).toHaveLength(2));
      const second = stub.connections[1] as StubConnection;
      await vi.waitFor(() => expect(second.texts).toHaveLength(1));
      expect(second.texts[0]).toBe(buildSonioxStartMessage({ apiKey: API_KEY, model: SONIOX_DEFAULT_MODEL }));

      second.send({ tokens: [token(" again", 200, 600), endpoint] });
      await vi.waitFor(() => expect(utterances).toHaveLength(2));
      expect(utterances[1]).toMatchObject({ text: "again", startMs: 1200, endMs: 1600 });
      expect(errors).toEqual([]);
      expect(lines.join("\n")).not.toContain(API_KEY);
    });

    it("reports a second loss once, makes no third connection and tolerates later audio", async () => {
      const { stub, provider, connection, errors } = await setupStarted();
      connection.closeGracefully();
      await vi.waitFor(() => expect(stub.connections).toHaveLength(2));
      const second = stub.connections[1] as StubConnection;
      await vi.waitFor(() => expect(second.texts).toHaveLength(1));

      second.closeGracefully();

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]?.message).toBe(SECOND_LOSS_MESSAGE);
      expect(errors[0]?.message).not.toContain(API_KEY);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.connections).toHaveLength(2);
      expect(errors).toHaveLength(1);
      expect(() => provider.pushAudio(createSilenceFrame(100))).not.toThrow();
    });

    it("logs an error response by code only and never its message", async () => {
      const { connection, lines } = await setupStarted();
      connection.send({ error_code: 401, error_message: `Invalid api key ${API_KEY}` });
      connection.closeGracefully();

      await vi.waitFor(() => expect(lines.some((line) => line.includes("401"))).toBe(true));
      for (const line of lines) expect(line).not.toContain(API_KEY);
    });
  });

  describe("close", () => {
    it("sends end of audio, emits the final tokens before resolving and is idempotent", async () => {
      const { provider, connection, utterances, errors, lines } = await setupStarted({
        onEndOfAudio: (conn: StubConnection) => {
          conn.send({ tokens: [token(" last", 0, 100), token(" words", 100, 200)] });
          conn.send({ finished: true });
        },
      });

      const closing = provider.close();
      expect(provider.close()).toBe(closing);
      await closing;

      await vi.waitFor(() => expect(connection.texts).toContain(""));
      expect(utterances.map((u) => u.text)).toEqual(["last words"]);
      await vi.waitFor(() => expect(connection.closed).toBe(true));

      await provider.close();
      expect(utterances).toHaveLength(1);
      expect(errors).toEqual([]);
      expect(lines.join("\n")).not.toContain(API_KEY);
    });

    it("still resolves within the flush timeout and emits pending when the server stays silent", async () => {
      const { provider, connection, utterances, errors } = await setupStarted({ onEndOfAudio: () => {} });
      connection.send({ tokens: [token(" pending", 0, 100)] });
      // Gives the token time to arrive; close() keeps processing messages while it waits.
      await new Promise((resolve) => setTimeout(resolve, 50));

      await provider.close();

      expect(utterances.map((u) => u.text)).toEqual(["pending"]);
      expect(errors).toEqual([]);
    }, 10_000);

    it("resolves when start was not called", async () => {
      const { provider } = await setup();
      await expect(provider.close()).resolves.toBeUndefined();
    });
  });
});
