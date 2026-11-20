import { describe, expect, it, vi } from "vitest";
import {
  ElevenLabsSpeechSynthesizer,
  MAX_SPEECH_AUDIO_BYTES,
  MAX_SPEECH_TEXT_CHARS,
} from "./ElevenLabsSpeechSynthesizer";
import { getSpeechSynthesisErrorKind } from "./IMeetingAgentSpeechSynthesizer";

const API_KEY = "eleven-secret-key";
const VOICE_ID = "voice/with space";
const MODEL_ID = "eleven_flash_v2_5";
const TEXT = "Spotkanie zaczyna się o dziesiątej";

type Call = { url: string; init: RequestInit };

function audioResponse(byteLength: number, status = 200, contentType = "audio/mpeg"): Response {
  return new Response(byteLength > 0 ? new Uint8Array(byteLength).fill(7) : null, {
    status,
    headers: { "content-type": contentType },
  });
}

function setup(next: Response | Error, overrides: { timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const synthesizer = new ElevenLabsSpeechSynthesizer({
    apiKey: API_KEY,
    voiceId: VOICE_ID,
    modelId: MODEL_ID,
    fetchFn,
    ...overrides,
  });
  return { synthesizer, calls, fetchFn };
}

describe("ElevenLabsSpeechSynthesizer", () => {
  it("posts the trimmed text to the voice's text-to-speech endpoint", async () => {
    const { synthesizer, calls } = setup(audioResponse(4000));
    await synthesizer.synthesize(`  ${TEXT}  `);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fwith%20space?output_format=mp3_22050_32"
    );
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({
      "xi-api-key": API_KEY,
      "content-type": "application/json",
      accept: "audio/mpeg",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: TEXT, model_id: MODEL_ID });
  });

  it("returns base64 mp3 with a duration derived from 32 kbps", async () => {
    const { synthesizer } = setup(audioResponse(4000));
    const speech = await synthesizer.synthesize(TEXT);
    expect(speech.kind).toBe("mp3");
    expect(speech.durationMs).toBe(1000);
    expect(Buffer.from(speech.base64, "base64")).toEqual(Buffer.alloc(4000, 7));
  });

  it("rounds the duration up", async () => {
    const { synthesizer } = setup(audioResponse(4001));
    await expect(synthesizer.synthesize(TEXT)).resolves.toMatchObject({ durationMs: 1001 });
  });

  it.each([401, 429, 500])("maps status %i to HTTP without echoing the text", async (status) => {
    const { synthesizer } = setup(
      new Response(JSON.stringify({ detail: TEXT }), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
    const error = await synthesizer.synthesize(TEXT).catch((e: unknown) => e);
    expect(getSpeechSynthesisErrorKind(error)).toBe("HTTP");
    expect(error).toMatchObject({ data: { status } });
    expect((error as Error).message).toBe(`ElevenLabs text-to-speech failed with status ${status}`);
    expect((error as Error).message).not.toContain(TEXT);
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it("times out a hanging request", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      ) as unknown as typeof fetch;
      const synthesizer = new ElevenLabsSpeechSynthesizer({
        apiKey: API_KEY,
        voiceId: VOICE_ID,
        modelId: MODEL_ID,
        fetchFn,
        timeoutMs: 1000,
      });
      const pending = synthesizer.synthesize(TEXT).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      const error = await pending;
      expect(getSpeechSynthesisErrorKind(error)).toBe("TIMEOUT");
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a rejected fetch as NETWORK with only the error name", async () => {
    const { synthesizer } = setup(new TypeError(`fetch failed for ${API_KEY} ${TEXT}`));
    const error = await synthesizer.synthesize(TEXT).catch((e: unknown) => e);
    expect(getSpeechSynthesisErrorKind(error)).toBe("NETWORK");
    expect((error as Error).message).toBe("ElevenLabs text-to-speech failed with TypeError");
  });

  it("rejects an empty audio body", async () => {
    const { synthesizer } = setup(audioResponse(0));
    expect(getSpeechSynthesisErrorKind(await synthesizer.synthesize(TEXT).catch((e: unknown) => e))).toBe(
      "INVALID_RESPONSE"
    );
  });

  it("rejects an oversized audio body", async () => {
    const { synthesizer } = setup(audioResponse(MAX_SPEECH_AUDIO_BYTES + 1));
    expect(getSpeechSynthesisErrorKind(await synthesizer.synthesize(TEXT).catch((e: unknown) => e))).toBe(
      "INVALID_RESPONSE"
    );
  });

  it("rejects a JSON body on a 200", async () => {
    const { synthesizer } = setup(audioResponse(100, 200, "application/json; charset=utf-8"));
    expect(getSpeechSynthesisErrorKind(await synthesizer.synthesize(TEXT).catch((e: unknown) => e))).toBe(
      "INVALID_RESPONSE"
    );
  });

  it.each([
    ["empty", "   "],
    ["too long", "a".repeat(MAX_SPEECH_TEXT_CHARS + 1)],
  ])("rejects %s text without calling ElevenLabs", async (_label, text) => {
    const { synthesizer, fetchFn } = setup(audioResponse(4000));
    const error = await synthesizer.synthesize(text).catch((e: unknown) => e);
    expect(getSpeechSynthesisErrorKind(error)).toBe("INVALID_INPUT");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts text of exactly the maximum length", async () => {
    const { synthesizer } = setup(audioResponse(4000));
    await expect(synthesizer.synthesize("a".repeat(MAX_SPEECH_TEXT_CHARS))).resolves.toMatchObject({
      kind: "mp3",
    });
  });
});

describe("getSpeechSynthesisErrorKind", () => {
  it("returns null for unrelated errors", () => {
    expect(getSpeechSynthesisErrorKind(new Error("boom"))).toBeNull();
    expect(getSpeechSynthesisErrorKind("boom")).toBeNull();
  });
});
