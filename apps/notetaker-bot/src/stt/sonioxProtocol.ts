// UNVERIFIED AGAINST THE REAL SERVICE (Soniox realtime API): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/smoke-test-google-meet.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import { z } from "zod";
import { AUDIO_SAMPLE_RATE_HZ } from "../audio/AudioFrame";

export const SONIOX_DEFAULT_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const SONIOX_DEFAULT_MODEL = "stt-rt-v3";
export const SONIOX_ENDPOINT_TOKEN = "<end>";

// An empty text frame tells the service the audio is over; it then finalises all tokens and sends
// { finished: true }. It lives here so the provider holds no wire-format assumption.
export const SONIOX_END_OF_AUDIO_MESSAGE = "";

export type SonioxToken = {
  text: string;
  start_ms?: number;
  end_ms?: number;
  is_final?: boolean;
  speaker?: string;
  language?: string;
};

export type SonioxResponse = {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
};

const sonioxTokenSchema = z.object({
  text: z.string(),
  start_ms: z.number().optional(),
  end_ms: z.number().optional(),
  is_final: z.boolean().optional(),
  speaker: z.string().optional(),
  language: z.string().optional(),
});

export const sonioxResponseSchema: z.ZodType<SonioxResponse> = z.object({
  tokens: z.array(sonioxTokenSchema).optional(),
  finished: z.boolean().optional(),
  error_code: z.number().optional(),
  error_message: z.string().optional(),
});

export function buildSonioxStartMessage(input: { apiKey: string; model: string }): string {
  return JSON.stringify({
    api_key: input.apiKey,
    model: input.model,
    audio_format: "pcm_s16le",
    sample_rate: AUDIO_SAMPLE_RATE_HZ,
    num_channels: 1,
    enable_speaker_diarization: true,
    enable_language_identification: true,
    enable_endpoint_detection: true,
  });
}
