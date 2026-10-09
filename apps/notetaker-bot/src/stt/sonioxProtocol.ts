// UNVERIFIED AGAINST THE REAL SERVICE (Soniox realtime API), in part. Most of the protocol was verified live on
// 2026-10-09 with scripts/soniox-smoke.ts (endpoint, bearer auth, start message, stt-rt-v5, token fields, <end>,
// end of stream, keepalive, the unauthenticated and model_not_available error frames). Still taken from Soniox's
// documentation only: the other error types (including the retryable ones) and the shape of leftover non-final
// tokens at end of stream. The register is docs/verification-status.md; remove this notice once those are recorded.
import { z } from "zod";
import { AUDIO_SAMPLE_RATE_HZ } from "../audio/AudioFrame";

const RETRYABLE_SONIOX_ERROR_TYPES: ReadonlySet<string> = new Set([
  "service_unavailable",
  "request_timeout",
  "internal_error",
  "max_duration_reached",
]);

export const SONIOX_DEFAULT_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const SONIOX_DEFAULT_MODEL = "stt-rt-v5";
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
  error_type?: string;
  request_id?: string;
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
  error_type: z.string().optional(),
  request_id: z.string().optional(),
});

// Soniox deprecated the api_key start-message field and refuses it from 15 Jan 2027, so the key travels only in
// the upgrade request's Authorization header.
export function buildSonioxAuthHeaders(apiKey: string): { Authorization: string } {
  return { Authorization: `Bearer ${apiKey}` };
}

export function buildSonioxStartMessage(input: { model: string }): string {
  return JSON.stringify({
    model: input.model,
    audio_format: "pcm_s16le",
    sample_rate: AUDIO_SAMPLE_RATE_HZ,
    num_channels: 1,
    enable_speaker_diarization: true,
    enable_language_identification: true,
    enable_endpoint_detection: true,
  });
}

// Soniox closes the connection when no audio is sent for a while unless this arrives at least every 20 s.
export const SONIOX_KEEPALIVE_MESSAGE = '{"type":"keepalive"}';

// The 429 types (limit_exceeded, max_concurrent_connections_reached) are deliberately not retried: an immediate
// reconnect hits the same limit. Unknown types are not retried either; a frame without a type is, as before.
export function isRetryableSonioxError(errorType: string | undefined): boolean {
  if (errorType === undefined) return true;
  return RETRYABLE_SONIOX_ERROR_TYPES.has(errorType);
}
