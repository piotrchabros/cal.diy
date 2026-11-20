import type { IMeetingAgentSpeechSynthesizer, SynthesizedSpeech } from "./IMeetingAgentSpeechSynthesizer";
import { createSpeechSynthesisError } from "./IMeetingAgentSpeechSynthesizer";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
// The output format is 32 kbps constant bitrate, i.e. 4 bytes of audio per millisecond.
const MP3_BYTES_PER_MS = 4;

export const ELEVENLABS_OUTPUT_FORMAT = "mp3_22050_32";
export const MAX_SPEECH_TEXT_CHARS = 1000;
export const MAX_SPEECH_AUDIO_BYTES = 2_000_000;

export class ElevenLabsSpeechSynthesizer implements IMeetingAgentSpeechSynthesizer {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(deps: {
    apiKey: string;
    voiceId: string;
    modelId: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    baseUrl?: string;
  }) {
    this.apiKey = deps.apiKey;
    this.voiceId = deps.voiceId;
    this.modelId = deps.modelId;
    this.fetchFn = deps.fetchFn;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  }

  async synthesize(text: string): Promise<SynthesizedSpeech> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw createSpeechSynthesisError("INVALID_INPUT", "Speech text is empty");
    }
    if (trimmed.length > MAX_SPEECH_TEXT_CHARS) {
      throw createSpeechSynthesisError(
        "INVALID_INPUT",
        `Speech text exceeds ${MAX_SPEECH_TEXT_CHARS} characters`
      );
    }

    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
    // Resolved per call because tests swap the global fetch after modules are loaded.
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    // AbortController + setTimeout rather than AbortSignal.timeout so fake timers can drive it.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let status: number;
    let contentType: string;
    let audio: ArrayBuffer;
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text: trimmed, model_id: this.modelId }),
        signal: controller.signal,
      });
      status = response.status;
      contentType = response.headers.get("content-type") ?? "";
      // The body is read inside the timeout window so a stalled stream is also aborted.
      audio = await response.arrayBuffer();
    } catch (error) {
      // Only the error name is reported so neither the spoken text nor the key can leak via a message.
      const errorName = error instanceof Error ? error.name : "UnknownError";
      if (timedOut) {
        throw createSpeechSynthesisError(
          "TIMEOUT",
          `ElevenLabs text-to-speech timed out after ${this.timeoutMs}ms`
        );
      }
      throw createSpeechSynthesisError("NETWORK", `ElevenLabs text-to-speech failed with ${errorName}`);
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) {
      throw createSpeechSynthesisError(
        "HTTP",
        `ElevenLabs text-to-speech failed with status ${status}`,
        status
      );
    }
    // ElevenLabs reports some failures as a JSON body, which must never be played as audio.
    if (contentType.toLowerCase().includes("json")) {
      throw createSpeechSynthesisError(
        "INVALID_RESPONSE",
        "ElevenLabs text-to-speech returned JSON instead of audio"
      );
    }
    if (audio.byteLength === 0 || audio.byteLength > MAX_SPEECH_AUDIO_BYTES) {
      throw createSpeechSynthesisError(
        "INVALID_RESPONSE",
        `ElevenLabs text-to-speech returned ${audio.byteLength} bytes of audio`
      );
    }

    return {
      kind: "mp3",
      base64: Buffer.from(audio).toString("base64"),
      durationMs: Math.ceil(audio.byteLength / MP3_BYTES_PER_MS),
    };
  }
}
