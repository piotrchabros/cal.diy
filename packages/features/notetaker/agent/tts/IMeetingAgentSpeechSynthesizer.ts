import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";

export type SynthesizedSpeech = { kind: "mp3"; base64: string; durationMs: number };

export interface IMeetingAgentSpeechSynthesizer {
  synthesize(text: string): Promise<SynthesizedSpeech>;
}

export type SpeechSynthesisErrorKind = "INVALID_INPUT" | "HTTP" | "TIMEOUT" | "NETWORK" | "INVALID_RESPONSE";

// ErrorCode has no member per failure mode, so the discriminator travels in `data`.
export function createSpeechSynthesisError(
  kind: SpeechSynthesisErrorKind,
  message: string,
  status?: number
): ErrorWithCode {
  const code = kind === "INVALID_INPUT" ? ErrorCode.BadRequest : ErrorCode.InternalServerError;
  return new ErrorWithCode(code, message, { speechSynthesisErrorKind: kind, status: status ?? null });
}

export function getSpeechSynthesisErrorKind(error: unknown): SpeechSynthesisErrorKind | null {
  if (!(error instanceof ErrorWithCode)) return null;
  const kind = error.data?.speechSynthesisErrorKind;
  if (
    kind !== "INVALID_INPUT" &&
    kind !== "HTTP" &&
    kind !== "TIMEOUT" &&
    kind !== "NETWORK" &&
    kind !== "INVALID_RESPONSE"
  ) {
    return null;
  }
  return kind;
}
