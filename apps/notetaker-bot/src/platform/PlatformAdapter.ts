import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import type { Pcm16Frame } from "../audio/AudioFrame";

export type PlatformName = NotetakerBotJoinRequest["platform"];

// Events carry no time: the runner stamps them on receipt.
export type PlatformEvent =
  // Entry requested, not yet let in.
  | { type: "waiting" }
  | { type: "admitted" }
  // Entry refused before admission.
  | { type: "denied" }
  // Includes the bot itself.
  | { type: "participant_count"; count: number }
  // Meeting UI signal.
  | { type: "speaker"; participantId: string; name: string; speaking: boolean }
  // Audio source signal, level in 0..1.
  | { type: "source_activity"; sourceKey: string; level: number }
  | { type: "source_identity"; sourceKey: string; participantId: string; name: string }
  | { type: "removed" }
  | { type: "meeting_ended" }
  | { type: "connection_lost" };

// Audio frames and the two source signals come through the handlers because the adapter owns the page that plays the audio.
export type PlatformHandlers = { onEvent(event: PlatformEvent): void; onAudioFrame(frame: Pcm16Frame): void };

export class PlatformLinkUnusableError extends Error {
  name = "PlatformLinkUnusableError";
}

// Four methods only (FR-016): the bot may join, post its notice and leave, nothing else.
export interface PlatformAdapter {
  readonly platform: PlatformName;
  // Resolves once entry is requested or granted; rejects with PlatformLinkUnusableError for an unusable link and with any other error when the browser failed.
  join(input: { meetingUrl: string; displayName: string }, handlers: PlatformHandlers): Promise<void>;
  postChatMessage(text: string): Promise<void>;
  // One attempt; true only when admitted again.
  reconnect(): Promise<boolean>;
  // Idempotent; releases the browser and every resource.
  leave(): Promise<void>;
}
