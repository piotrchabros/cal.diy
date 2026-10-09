// @vitest-environment node
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import type { Pcm16Frame } from "../audio/AudioFrame";
import { AUDIO_SAMPLE_RATE_HZ, createSilenceFrame } from "../audio/AudioFrame";
import { createLogger } from "../logger";
import { SonioxRealtimeProvider } from "./SonioxRealtimeProvider";
import type { SttUtterance } from "./SpeechToTextProvider";
import type { SonioxResponse } from "./sonioxProtocol";
import {
  buildSonioxAuthHeaders,
  buildSonioxStartMessage,
  isRetryableSonioxError,
  SONIOX_DEFAULT_MODEL,
  SONIOX_ENDPOINT_TOKEN,
  SONIOX_KEEPALIVE_MESSAGE,
  sonioxResponseSchema,
} from "./sonioxProtocol";

const API_KEY = "soniox-test-key-not-real";
const WRONG_API_KEY = "soniox-wrong-key-not-real";
const SECOND_LOSS_MESSAGE = "Soniox realtime connection was lost twice; transcription has stopped";
const NORMAL_CLOSE_CODE = 1000;
const REQUEST_ID = "3d37a3bd-0000-4000-8000-stubrequest1";
// Echoes the key the way a real error message could, so a log line carrying it is caught twice.
const ERROR_DETAIL = `stub error detail for ${API_KEY}`;

const NON_RETRYABLE_ERRORS: [errorType: string, errorCode: number][] = [
  ["unauthenticated", 401],
  ["invalid_request", 400],
  ["model_not_available", 400],
  ["permission_denied", 403],
  ["organization_balance_exhausted", 402],
  ["organization_monthly_budget_exhausted", 402],
  ["project_monthly_budget_exhausted", 402],
];

const RETRYABLE_ERRORS: [errorType: string, errorCode: number][] = [
  ["service_unavailable", 503],
  ["request_timeout", 408],
  ["internal_error", 500],
  ["max_duration_reached", 413],
];

// The service sends fields the provider does not read; the stub sends them anyway so the frames
// have the documented shape.
type StubFrame = SonioxResponse & {
  final_audio_proc_ms?: number;
  total_audio_proc_ms?: number;
  more_info?: string;
};

type StubConnection = {
  socket: WebSocket;
  requestUrl: string | undefined;
  headers: IncomingHttpHeaders;
  authorized: boolean;
  texts: string[];
  binaries: Buffer[];
  // Arrival order of messages, true for binary, so a test can assert the first message is text.
  order: boolean[];
  closed: boolean;
  send(response: StubFrame): void;
  sendRaw(text: string): void;
  // The end of a stream as documented and as traced live on 2026-10-09: one finished response with no
  // tokens and both progress counters equal, then the server closes with code 1000.
  finish(): void;
  // The documented failure: one error frame, then the server closes with a normal close code.
  fail(errorType: string, errorCode: number): void;
  drop(): void;
  closeGracefully(): void;
};

type StubOptions = {
  // Defaults to the documented end of stream so close() is quick.
  onEndOfAudio?: (connection: StubConnection) => void;
};

type Stub = {
  url: string;
  connections: StubConnection[];
  close(): Promise<void>;
};

type ProviderOverrides = {
  apiKey?: string;
  model?: string;
  maxUtteranceMs?: number;
  maxTokenGapMs?: number;
  keepaliveIntervalMs?: number;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
};

async function startStubSoniox(options: StubOptions = {}): Promise<Stub> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("The stub server did not report a port");
  }

  const connections: StubConnection[] = [];
  const onEndOfAudio = options.onEndOfAudio ?? ((connection: StubConnection) => connection.finish());

  server.on("connection", (socket, request) => {
    const connection: StubConnection = {
      socket,
      requestUrl: request.url,
      headers: request.headers,
      authorized: request.headers.authorization === `Bearer ${API_KEY}`,
      texts: [],
      binaries: [],
      order: [],
      closed: false,
      send: (response) => socket.send(JSON.stringify(response)),
      sendRaw: (text) => socket.send(text),
      finish: () => {
        connection.send({ tokens: [], final_audio_proc_ms: 1680, total_audio_proc_ms: 1680, finished: true });
        socket.close(NORMAL_CLOSE_CODE);
      },
      fail: (errorType, errorCode) => {
        connection.send({
          tokens: [],
          error_code: errorCode,
          error_type: errorType,
          error_message: ERROR_DETAIL,
          more_info: "https://stub.invalid/errors",
          request_id: REQUEST_ID,
        });
        socket.close(NORMAL_CLOSE_CODE);
      },
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
    // The real service accepts the handshake and reports a bad key as an error frame afterwards.
    if (!connection.authorized) connection.fail("unauthenticated", 401);
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

async function setup(stubOptions: StubOptions = {}, providerOptions: ProviderOverrides = {}) {
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

async function setupStarted(stubOptions: StubOptions = {}, providerOptions: ProviderOverrides = {}) {
  const context = await setup(stubOptions, providerOptions);
  await context.provider.start(context.handlers);
  await vi.waitFor(() => expect(context.stub.connections).toHaveLength(1));
  return { ...context, connection: context.stub.connections[0] as StubConnection };
}

describe("sonioxProtocol", () => {
  it("defaults to the only active realtime model", () => {
    expect(SONIOX_DEFAULT_MODEL).toBe("stt-rt-v5");
  });

  it("builds the start message with the fixed audio and feature settings and no key", () => {
    const parsed: unknown = JSON.parse(buildSonioxStartMessage({ model: "some-model" }));
    expect(parsed).toEqual({
      model: "some-model",
      audio_format: "pcm_s16le",
      sample_rate: AUDIO_SAMPLE_RATE_HZ,
      num_channels: 1,
      enable_speaker_diarization: true,
      enable_language_identification: true,
      enable_endpoint_detection: true,
    });
    expect(parsed).not.toHaveProperty("api_key");
  });

  it("builds the bearer authorization header from the key", () => {
    expect(buildSonioxAuthHeaders(API_KEY)).toEqual({ Authorization: `Bearer ${API_KEY}` });
  });

  it("uses the documented keepalive frame", () => {
    expect(SONIOX_KEEPALIVE_MESSAGE).toBe('{"type":"keepalive"}');
  });

  it("accepts token, finished and error responses and rejects a token without text", () => {
    expect(
      sonioxResponseSchema.safeParse({ tokens: [{ text: "a", is_final: true, confidence: 0.9 }], extra: 1 })
        .success
    ).toBe(true);
    expect(sonioxResponseSchema.safeParse({ finished: true }).success).toBe(true);
    expect(
      sonioxResponseSchema.safeParse({
        tokens: [],
        final_audio_proc_ms: 1560,
        total_audio_proc_ms: 1680,
        finished: true,
      }).success
    ).toBe(true);
    expect(sonioxResponseSchema.safeParse({ error_code: 401, error_message: "nope" }).success).toBe(true);
    expect(sonioxResponseSchema.safeParse({ tokens: [{ start_ms: 1 }] }).success).toBe(false);
  });

  it("keeps the error type and request id of a documented error frame", () => {
    const parsed = sonioxResponseSchema.safeParse({
      tokens: [],
      error_code: 503,
      error_type: "service_unavailable",
      error_message: "try again",
      more_info: "https://stub.invalid/errors",
      request_id: REQUEST_ID,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      error_code: 503,
      error_type: "service_unavailable",
      request_id: REQUEST_ID,
    });
    expect(sonioxResponseSchema.safeParse({ error_type: 503 }).success).toBe(false);
    expect(sonioxResponseSchema.safeParse({ request_id: 1 }).success).toBe(false);
  });

  it.each([
    ["service_unavailable", true],
    ["request_timeout", true],
    ["internal_error", true],
    ["max_duration_reached", true],
    [undefined, true],
    ["unauthenticated", false],
    ["invalid_request", false],
    ["model_not_available", false],
    ["permission_denied", false],
    ["temp_api_key_session_expired", false],
    ["organization_balance_exhausted", false],
    ["organization_monthly_budget_exhausted", false],
    ["project_monthly_budget_exhausted", false],
    ["limit_exceeded", false],
    ["max_concurrent_connections_reached", false],
    ["some_type_added_later", false],
    ["", false],
  ])("treats error type %s as retryable: %s", (errorType, expected) => {
    expect(isRetryableSonioxError(errorType)).toBe(expected);
  });
});

describe("SonioxRealtimeProvider", () => {
  describe("start", () => {
    it("authenticates with a bearer header and sends a keyless start message first as text", async () => {
      const { connection, errors } = await setupStarted();
      await vi.waitFor(() => expect(connection.order.length).toBeGreaterThan(0));
      expect(connection.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(connection.order[0]).toBe(false);
      expect(connection.texts[0]).toBe(buildSonioxStartMessage({ model: SONIOX_DEFAULT_MODEL }));
      expect(JSON.parse(connection.texts[0] ?? "{}")).not.toHaveProperty("api_key");
      expect(connection.texts[0] ?? "").not.toContain(API_KEY);
      expect(connection.requestUrl ?? "").not.toContain(API_KEY);
      expect(errors).toEqual([]);
    });

    it("uses an injected model", async () => {
      const { connection } = await setupStarted({}, { model: "custom-model" });
      await vi.waitFor(() => expect(connection.texts).toHaveLength(1));
      expect(connection.texts[0]).toBe(buildSonioxStartMessage({ model: "custom-model" }));
    });

    it("hands the url and the bearer header to an injected socket factory", async () => {
      const calls: { url: string; headers: Record<string, string> }[] = [];
      const { stub, connection } = await setupStarted(
        {},
        {
          createSocket: (url, headers) => {
            calls.push({ url, headers });
            return new WebSocket(url, { headers });
          },
        }
      );

      expect(calls).toEqual([{ url: stub.url, headers: buildSonioxAuthHeaders(API_KEY) }]);
      expect(connection.authorized).toBe(true);
    });

    it("reports a rejected key once and does not reconnect", async () => {
      const { stub, provider, handlers, errors, lines } = await setup({}, { apiKey: WRONG_API_KEY });
      await provider.start(handlers);

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.connections).toHaveLength(1);
      expect(stub.connections[0]?.authorized).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).not.toContain(WRONG_API_KEY);
      expect(lines.join("\n")).not.toContain(WRONG_API_KEY);
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

  describe("keepalive", () => {
    it("sends the keepalive frame repeatedly while no audio is sent", async () => {
      const { connection, errors } = await setupStarted({}, { keepaliveIntervalMs: 40 });

      await vi.waitFor(() =>
        expect(
          connection.texts.filter((text) => text === SONIOX_KEEPALIVE_MESSAGE).length
        ).toBeGreaterThanOrEqual(2)
      );
      expect(connection.closed).toBe(false);
      expect(errors).toEqual([]);
    });

    it("sends no keepalive while audio flows and resumes once it stops", async () => {
      const { provider, connection } = await setupStarted({}, { keepaliveIntervalMs: 150 });

      const pushing = setInterval(() => provider.pushAudio(createSilenceFrame(10)), 10);
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        clearInterval(pushing);
      }

      expect(connection.binaries.length).toBeGreaterThan(0);
      expect(connection.texts).not.toContain(SONIOX_KEEPALIVE_MESSAGE);
      await vi.waitFor(() => expect(connection.texts).toContain(SONIOX_KEEPALIVE_MESSAGE));
    });

    it("keeps the replacement connection alive after a reconnect", async () => {
      const { stub, connection } = await setupStarted({}, { keepaliveIntervalMs: 40 });
      connection.drop();

      await vi.waitFor(() => expect(stub.connections).toHaveLength(2));
      const second = stub.connections[1] as StubConnection;
      await vi.waitFor(() => expect(second.texts).toContain(SONIOX_KEEPALIVE_MESSAGE));
      expect(second.texts[0]).toBe(buildSonioxStartMessage({ model: SONIOX_DEFAULT_MODEL }));
    });

    it("sends no keepalive after the end-of-audio frame", async () => {
      // The delayed answer leaves several keepalive intervals between the end-of-audio frame and
      // the end of close().
      const { provider, connection } = await setupStarted(
        { onEndOfAudio: (conn: StubConnection) => setTimeout(() => conn.finish(), 250) },
        { keepaliveIntervalMs: 40 }
      );

      await provider.close();

      await vi.waitFor(() => expect(connection.closed).toBe(true));
      expect(connection.texts).toContain("");
      expect(connection.texts.slice(connection.texts.indexOf("") + 1)).toEqual([]);
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
      expect(second.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(second.texts[0]).toBe(buildSonioxStartMessage({ model: SONIOX_DEFAULT_MODEL }));

      second.send({ tokens: [token(" again", 200, 600), endpoint] });
      await vi.waitFor(() => expect(utterances).toHaveLength(2));
      expect(utterances[1]).toMatchObject({ text: "again", startMs: 1200, endMs: 1600 });
      expect(errors).toEqual([]);
      expect(lines.join("\n")).not.toContain(API_KEY);
    });

    it("reconnects once when the connection drops without an error frame", async () => {
      const { stub, connection, errors } = await setupStarted();
      connection.drop();

      await vi.waitFor(() => expect(stub.connections).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.connections).toHaveLength(2);
      expect(errors).toEqual([]);
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

    it("labels a speaker differently after a reconnect and consistently within a connection", async () => {
      const { stub, connection, utterances } = await setupStarted();
      connection.send({ tokens: [token(" one", 0, 100, { speaker: "1" }), endpoint] });
      connection.send({ tokens: [token(" two", 200, 300, { speaker: "1" }), endpoint] });
      await vi.waitFor(() => expect(utterances).toHaveLength(2));
      connection.closeGracefully();

      await vi.waitFor(() => expect(stub.connections).toHaveLength(2));
      const second = stub.connections[1] as StubConnection;
      second.send({ tokens: [token(" three", 0, 100, { speaker: "1" }), endpoint] });
      second.send({ tokens: [token(" four", 200, 300, { speaker: "1" }), endpoint] });
      second.send({ tokens: [token(" five", 400, 500, { speaker: "2" }), endpoint] });
      await vi.waitFor(() => expect(utterances).toHaveLength(5));

      const labels = utterances.map((utterance) => utterance.diarizationLabel);
      expect(labels[0]).toBe("1");
      expect(labels[1]).toBe("1");
      // The service numbers speakers per connection, so "1" may now be somebody else.
      expect(labels[2]).not.toBeNull();
      expect(labels[2]).not.toBe(labels[0]);
      expect(labels[3]).toBe(labels[2]);
      expect(labels[4]).not.toBeNull();
      expect(labels[4]).not.toBe(labels[2]);
    });
  });

  describe("error frames", () => {
    it.each(NON_RETRYABLE_ERRORS)("reports %s once and does not reconnect", async (errorType, errorCode) => {
      const { stub, provider, connection, errors } = await setupStarted();
      await vi.waitFor(() => expect(connection.texts).toHaveLength(1));

      connection.fail(errorType, errorCode);

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.connections).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).not.toContain(API_KEY);
      expect(errors[0]?.message).not.toContain(ERROR_DETAIL);
      expect(() => provider.pushAudio(createSilenceFrame(100))).not.toThrow();
    });

    it.each(RETRYABLE_ERRORS)("reconnects exactly once after %s", async (errorType, errorCode) => {
      const { stub, connection, utterances, errors } = await setupStarted();
      await vi.waitFor(() => expect(connection.texts).toHaveLength(1));

      connection.fail(errorType, errorCode);

      await vi.waitFor(() => expect(stub.connections).toHaveLength(2));
      const second = stub.connections[1] as StubConnection;
      await vi.waitFor(() => expect(second.texts).toHaveLength(1));
      expect(second.authorized).toBe(true);
      expect(second.texts[0]).toBe(buildSonioxStartMessage({ model: SONIOX_DEFAULT_MODEL }));

      second.send({ tokens: [token(" recovered", 0, 100), endpoint] });
      await vi.waitFor(() => expect(utterances).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.connections).toHaveLength(2);
      expect(errors).toEqual([]);
    });

    it("stops after a non-retryable error on the replacement connection without a third attempt", async () => {
      const { stub, connection, errors } = await setupStarted();
      connection.fail("service_unavailable", 503);
      await vi.waitFor(() => expect(stub.connections).toHaveLength(2));
      const second = stub.connections[1] as StubConnection;
      await vi.waitFor(() => expect(second.texts).toHaveLength(1));

      second.fail("invalid_request", 400);

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.connections).toHaveLength(2);
      expect(errors).toHaveLength(1);
    });

    it("flushes the pending utterance before reporting a non-retryable error", async () => {
      const { connection, utterances, errors } = await setupStarted();
      connection.send({ tokens: [token(" before the error", 0, 100)] });

      connection.fail("invalid_request", 400);

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(utterances.map((u) => u.text)).toEqual(["before the error"]);
    });

    it.each([
      ["unauthenticated", 401],
      ["service_unavailable", 503],
    ])("logs %s by code, type and request id and never its message", async (errorType, errorCode) => {
      const { connection, lines } = await setupStarted();
      connection.fail(errorType, errorCode);

      await vi.waitFor(() => expect(connection.closed).toBe(true));
      await vi.waitFor(() => expect(lines.some((line) => line.includes(REQUEST_ID))).toBe(true));
      const logged = lines.join("\n");
      expect(logged).toContain(String(errorCode));
      expect(logged).toContain(errorType);
      expect(logged).not.toContain(ERROR_DETAIL);
      expect(logged).not.toContain(API_KEY);
    });
  });

  describe("close", () => {
    it("sends end of audio, emits the final tokens before resolving and is idempotent", async () => {
      const { stub, provider, connection, utterances, errors, lines } = await setupStarted({
        onEndOfAudio: (conn: StubConnection) => {
          conn.send({ tokens: [token(" last", 0, 100), token(" words", 100, 200)] });
          conn.finish();
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
      // The server ends the stream by closing the socket itself, which must not look like a loss.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.connections).toHaveLength(1);
    });

    // Not seen in the live traces, where nothing was left over at the end of the audio; it is the one
    // end-of-stream shape the test above does not exercise.
    it("emits final tokens that arrive in the finished response itself, without an endpoint token", async () => {
      const { provider, utterances, errors } = await setupStarted({
        onEndOfAudio: (conn: StubConnection) => {
          conn.send({
            tokens: [token(" Okay.", 16020, 16080, { speaker: "1", language: "en" })],
            finished: true,
          });
          conn.socket.close(NORMAL_CLOSE_CODE);
        },
      });

      await provider.close();

      expect(utterances).toEqual([
        { startMs: 16020, endMs: 16080, text: "Okay.", language: "en", diarizationLabel: "1" },
      ]);
      expect(errors).toEqual([]);
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
