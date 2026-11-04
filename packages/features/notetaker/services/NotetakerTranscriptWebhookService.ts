import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { INotetakerMembershipLookup } from "../lib/membershipLookup";
import { buildNotetakerTranscriptWebhookPayload } from "../lib/transcriptWebhookPayload";
import { isTranscriptSharedWithTeam, resolveMemberSharingTeamIdsForSource } from "../lib/webhookSharingTeam";
import type { IBookingNotetakerRepository } from "../repositories/interfaces/IBookingNotetakerRepository";
import type { INotetakerSessionRepository } from "../repositories/interfaces/INotetakerSessionRepository";
import type { INotetakerSummaryRepository } from "../repositories/interfaces/INotetakerSummaryRepository";
import type { INotetakerTranscriptRepository } from "../repositories/interfaces/INotetakerTranscriptRepository";
import type { INotetakerTranscriptWebhookGateway } from "../webhooks/INotetakerTranscriptWebhookGateway";

export interface INotetakerTranscriptWebhookNotifier {
  sendOnce(params: { transcriptId: string }): Promise<void>;
}

export interface INotetakerTranscriptWebhookServiceDeps {
  sessionRepository: Pick<INotetakerSessionRepository, "findById">;
  transcriptRepository: Pick<
    INotetakerTranscriptRepository,
    "findById" | "findAllPassages" | "claimWebhookDispatch"
  >;
  summaryRepository: Pick<INotetakerSummaryRepository, "findByTranscriptId">;
  bookingNotetakerRepository: Pick<IBookingNotetakerRepository, "findByBookingIdIncludeBooking">;
  webhookGateway: INotetakerTranscriptWebhookGateway;
  membershipLookup: Pick<INotetakerMembershipLookup, "isAcceptedMember">;
  logger: ISimpleLogger;
}

export class NotetakerTranscriptWebhookService implements INotetakerTranscriptWebhookNotifier {
  constructor(private readonly deps: INotetakerTranscriptWebhookServiceDeps) {}

  // Never throws: callers settle the transcript first and a webhook problem must not undo that.
  // Logs ids only, because passages and summaries are meeting content.
  async sendOnce(params: { transcriptId: string }): Promise<void> {
    const { transcriptId } = params;
    try {
      await this.send(transcriptId);
    } catch (error) {
      this.deps.logger.error("Notetaker transcript webhook failed", {
        transcriptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async send(transcriptId: string): Promise<void> {
    const {
      sessionRepository,
      transcriptRepository,
      summaryRepository,
      bookingNotetakerRepository,
      webhookGateway,
      membershipLookup,
      logger,
    } = this.deps;

    const transcript = await transcriptRepository.findById(transcriptId);
    if (!transcript) return;

    const session = await sessionRepository.findById(transcript.sessionId);
    if (!session || session.resultsDeletedAt) return;

    const passages = await transcriptRepository.findAllPassages(transcript.id);
    if (passages.length === 0) return;

    const booking = await bookingNotetakerRepository.findByBookingIdIncludeBooking(transcript.bookingId);
    if (!booking || booking.userId === null) return;

    // The owner's own subscriptions, plus opted-in webhooks of the one team the notetaker sharing rules
    // already show this transcript to. Other team or org webhooks could reach people those rules exclude.
    const memberSharingTeamIds = isTranscriptSharedWithTeam(session)
      ? await resolveMemberSharingTeamIdsForSource(
          { ownerUserId: booking.userId, source: booking },
          membershipLookup
        )
      : [];
    const found = await webhookGateway.findSubscribers({ userId: booking.userId, memberSharingTeamIds });
    const subscribers = Array.from(new Map(found.map((subscriber) => [subscriber.id, subscriber])).values());
    if (subscribers.length === 0) return;

    // Built before claiming so a booking that cannot be serialised leaves the transcript unclaimed.
    // Ad-hoc and calendar-meeting bookings have no event type, so they get the meeting payload.
    const payloadParams = { bookingId: booking.id, fallbackVideoCallUrl: session.meetingUrl };
    const bookingPayload =
      booking.eventTypeId === null
        ? await webhookGateway.buildMeetingPayload(payloadParams)
        : await webhookGateway.buildBookingPayload(payloadParams);
    if (!bookingPayload) return;

    const summary = await summaryRepository.findByTranscriptId(transcript.id);
    const payload = {
      ...bookingPayload,
      notetaker: buildNotetakerTranscriptWebhookPayload({ transcript, passages, summary }),
    };

    const now = new Date();
    const claimed = await transcriptRepository.claimWebhookDispatch(transcript.id, now);
    if (!claimed) return;

    const { attempted, failed } = await webhookGateway.deliver({
      subscribers,
      createdAt: now.toISOString(),
      payload,
    });
    logger.info("Notetaker transcript webhook dispatched", {
      transcriptId: transcript.id,
      bookingId: booking.id,
      attempted,
      failed,
    });
  }
}
