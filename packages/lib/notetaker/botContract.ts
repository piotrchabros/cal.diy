// Shared with apps/notetaker-bot, which has no access to the rest of the monorepo's packages:
// keep the imports of this file to `zod` and Node's `crypto`.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const NOTETAKER_TIMESTAMP_HEADER = "X-Notetaker-Timestamp";
export const NOTETAKER_SIGNATURE_HEADER = "X-Notetaker-Signature";
export const NOTETAKER_SIGNATURE_TOLERANCE_SECONDS = 300;

const MAX_PASSAGE_TEXT_LENGTH = 1000;
const MAX_PASSAGES_PER_EVENT = 50;

const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d+$/;

const isoUtcDateTimeSchema = z.string().datetime();
const millisecondsSchema = z.number().int().nonnegative();

export const notetakerBotEndReasonSchema = z.enum([
  "MEETING_ENDED",
  "ALONE_TIMEOUT",
  "NOT_ADMITTED",
  "MEETING_DID_NOT_START",
  "REMOVED_BY_PARTICIPANT",
  "STOP_REQUESTED",
  "INTERRUPTED",
  "LENGTH_LIMIT_REACHED",
  "MEETING_LINK_UNUSABLE",
]);

export type NotetakerBotEndReason = z.infer<typeof notetakerBotEndReasonSchema>;

export const notetakerBotPassageSchema = z
  .object({
    index: z.number().int().nonnegative(),
    speakerKey: z.string().min(1),
    speakerName: z.string().min(1).nullable(),
    unknownSpeakerNumber: z.number().int().nonnegative().nullable(),
    startMs: millisecondsSchema,
    endMs: millisecondsSchema,
    text: z.string().min(1).max(MAX_PASSAGE_TEXT_LENGTH),
    language: z.string().nullable(),
  })
  .refine((passage) => passage.endMs >= passage.startMs, {
    message: "endMs must not be before startMs",
    path: ["endMs"],
  })
  .refine((passage) => (passage.speakerName === null) !== (passage.unknownSpeakerNumber === null), {
    message: "Exactly one of speakerName and unknownSpeakerNumber must be set",
    path: ["speakerName"],
  });

export type NotetakerBotPassage = z.infer<typeof notetakerBotPassageSchema>;

const eventEnvelopeShape = {
  eventId: z.string().uuid(),
  sessionId: z.string().min(1),
  sequence: z.number().int().min(1),
  occurredAt: isoUtcDateTimeSchema,
};

export const notetakerBotEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventEnvelopeShape, type: z.literal("session.join_requested"), data: z.object({}) }),
  z.object({ ...eventEnvelopeShape, type: z.literal("session.admitted"), data: z.object({}) }),
  z.object({ ...eventEnvelopeShape, type: z.literal("session.notice_posted"), data: z.object({}) }),
  z.object({
    ...eventEnvelopeShape,
    type: z.literal("session.heartbeat"),
    data: z.object({ participantCount: z.number().int().nonnegative() }),
  }),
  z.object({
    ...eventEnvelopeShape,
    type: z.literal("session.reconnecting"),
    data: z.object({ atMs: millisecondsSchema }),
  }),
  z.object({
    ...eventEnvelopeShape,
    type: z.literal("transcript.passages"),
    data: z.object({ passages: z.array(notetakerBotPassageSchema).max(MAX_PASSAGES_PER_EVENT) }),
  }),
  z.object({
    ...eventEnvelopeShape,
    type: z.literal("session.ended"),
    data: z.object({
      endReason: notetakerBotEndReasonSchema,
      durationMs: millisecondsSchema,
      interruptedAtMs: millisecondsSchema.nullable(),
      passageCount: z.number().int().nonnegative(),
    }),
  }),
]);

export type NotetakerBotEvent = z.infer<typeof notetakerBotEventSchema>;

const limitSecondsSchema = z.number().int().positive();

export const notetakerBotJoinRequestSchema = z.object({
  sessionId: z.string().min(1),
  platform: z.enum(["GOOGLE_MEET", "MICROSOFT_TEAMS"]),
  meetingUrl: z.string().url(),
  displayName: z.string().min(1),
  noticeMessage: z.string().min(1),
  scheduledStartAt: isoUtcDateTimeSchema,
  callbackUrl: z.string().url(),
  limits: z.object({
    admissionTimeoutSeconds: limitSecondsSchema,
    noShowTimeoutSeconds: limitSecondsSchema,
    aloneTimeoutSeconds: limitSecondsSchema,
    maxDurationSeconds: limitSecondsSchema,
  }),
});

export type NotetakerBotJoinRequest = z.infer<typeof notetakerBotJoinRequestSchema>;

export const notetakerBotJoinResponseSchema = z.object({
  sessionId: z.string().min(1),
  externalRef: z.string().min(1),
});

export const notetakerBotStopReasonSchema = z.enum(["STOPPED_BY_HOST", "BOOKING_NOT_ACTIVE", "DISABLED"]);

export type NotetakerBotStopReason = z.infer<typeof notetakerBotStopReasonSchema>;

export const notetakerBotStopRequestSchema = z.object({
  reason: notetakerBotStopReasonSchema,
});

export const notetakerBotStateSchema = z.object({
  sessionId: z.string().min(1),
  phase: z.enum(["STARTING", "WAITING", "IN_MEETING", "ENDED"]),
  lastEventSequence: z.number().int().nonnegative(),
});

export type NotetakerBotStateDto = z.infer<typeof notetakerBotStateSchema>;

export function signNotetakerPayload(input: {
  secret: string;
  timestamp: number | string;
  rawBody: string;
}): string {
  const digest = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.rawBody}`)
    .digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

export function verifyNotetakerSignature(input: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  // An unset secret must never authenticate anything, even a request signed with the empty string.
  if (!input.secret) return false;
  if (!input.timestamp || !TIMESTAMP_PATTERN.test(input.timestamp)) return false;
  if (!input.signature || !SIGNATURE_PATTERN.test(input.signature)) return false;

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(input.timestamp)) > NOTETAKER_SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = signNotetakerPayload({
    secret: input.secret,
    timestamp: input.timestamp,
    rawBody: input.rawBody,
  });

  // SIGNATURE_PATTERN fixes the length, which timingSafeEqual requires to be equal on both sides.
  return timingSafeEqual(Buffer.from(input.signature), Buffer.from(expected));
}
