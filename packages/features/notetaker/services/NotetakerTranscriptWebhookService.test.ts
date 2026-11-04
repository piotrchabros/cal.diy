import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { WebhookSubscriber } from "@calcom/features/webhooks/lib/dto/types";
import type {
  EventPayloadType,
  NotetakerMeetingTranscriptPayload,
} from "@calcom/features/webhooks/lib/sendPayload";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTETAKER_AD_HOC_KEY } from "../lib/adHocMeeting";
import { NOTETAKER_CALENDAR_MEETING_KEY } from "../lib/calendarMeeting";
import {
  buildNotetakerMeetingBookingPayload,
  type NotetakerMeetingBookingPayload,
} from "../lib/meetingBookingPayload";
import type { IBookingNotetakerRepository } from "../repositories/interfaces/IBookingNotetakerRepository";
import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import type { INotetakerTranscriptWebhookGateway } from "../webhooks/INotetakerTranscriptWebhookGateway";
import { NotetakerTranscriptWebhookService } from "./NotetakerTranscriptWebhookService";

const BOOKING_ID = 100;
const ORGANIZER_ID = 1;
const TEAM_ID = 20;
const MEETING_URL = "https://meet.google.com/abc-defg-hij";
const NOW = new Date("2026-10-12T11:00:00.000Z");
const SECRET_TOKEN = "zxqvsecretpassagetoken";

function buildBooking(overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  return {
    id: BOOKING_ID,
    uid: "booking-uid-1",
    userId: ORGANIZER_ID,
    status: "ACCEPTED",
    startTime: new Date("2026-10-12T10:00:00.000Z"),
    endTime: new Date("2026-10-12T10:30:00.000Z"),
    title: "Planning call",
    location: null,
    metadata: null,
    recurringEventId: null,
    eventTypeId: 10,
    attendeeEmails: ["attendee@example.com"],
    references: [],
    eventTypeHosts: [],
    organizer: { id: ORGANIZER_ID, name: "Organizer", email: "organizer@example.com", locale: "en" },
    ...overrides,
  };
}

function buildPassage(overrides: Partial<NotetakerPassageRecord>): NotetakerPassageRecord {
  return {
    index: 0,
    speakerKey: "speaker-1",
    speakerName: "Alex",
    unknownSpeakerNumber: null,
    startMs: 0,
    endMs: 1000,
    text: `we shipped ${SECRET_TOKEN} today`,
    language: "en",
    ...overrides,
  };
}

function buildSubscriber(id: string): WebhookSubscriber {
  return {
    id,
    subscriberUrl: `https://crm.example/${id}`,
    payloadTemplate: null,
    appId: null,
    secret: `secret-${id}`,
    eventTriggers: ["RECORDING_TRANSCRIPTION_GENERATED"],
    version: "2021-10-20",
  } as WebhookSubscriber;
}

type DeliveredPayload = EventPayloadType | NotetakerMeetingTranscriptPayload;

// buildMeetingPayload reads the in-memory repository through the real builder, like the Cal.com gateway.
class FakeWebhookGateway implements INotetakerTranscriptWebhookGateway {
  constructor(
    private readonly bookingNotetakerRepository: Pick<IBookingNotetakerRepository, "findMeetingForWebhook">
  ) {}

  subscribers: WebhookSubscriber[] = [buildSubscriber("wh-1"), buildSubscriber("wh-2")];
  teamSubscribers = new Map<number, WebhookSubscriber[]>();
  bookingPayload: EventPayloadType | null = {
    uid: "booking-uid-1",
    title: "Planning call",
  } as EventPayloadType;
  findSubscribersCalls: { userId: number; memberSharingTeamIds?: number[] }[] = [];
  buildBookingPayloadCalls: { bookingId: number; fallbackVideoCallUrl: string | null }[] = [];
  buildMeetingPayloadCalls: { bookingId: number; fallbackVideoCallUrl: string | null }[] = [];
  deliverCalls: { subscribers: WebhookSubscriber[]; createdAt: string; payload: DeliveredPayload }[] = [];
  deliverError: Error | null = null;
  onDeliver: (() => Promise<void>) | null = null;

  async findSubscribers(params: {
    userId: number;
    memberSharingTeamIds?: number[];
  }): Promise<WebhookSubscriber[]> {
    this.findSubscribersCalls.push(params);
    const teamSubscribers = (params.memberSharingTeamIds ?? []).flatMap(
      (teamId) => this.teamSubscribers.get(teamId) ?? []
    );
    return [...this.subscribers, ...teamSubscribers];
  }

  async buildBookingPayload(params: {
    bookingId: number;
    fallbackVideoCallUrl: string | null;
  }): Promise<EventPayloadType | null> {
    this.buildBookingPayloadCalls.push(params);
    return this.bookingPayload;
  }

  async buildMeetingPayload(params: {
    bookingId: number;
    fallbackVideoCallUrl: string | null;
  }): Promise<NotetakerMeetingBookingPayload | null> {
    this.buildMeetingPayloadCalls.push(params);
    const meeting = await this.bookingNotetakerRepository.findMeetingForWebhook(params.bookingId);
    if (!meeting?.owner) return null;
    return buildNotetakerMeetingBookingPayload({
      booking: meeting.booking,
      owner: meeting.owner,
      contacts: meeting.contacts,
      fallbackVideoCallUrl: params.fallbackVideoCallUrl,
    });
  }

  async deliver(params: {
    subscribers: WebhookSubscriber[];
    createdAt: string;
    payload: DeliveredPayload;
  }): Promise<{ attempted: number; failed: number }> {
    this.deliverCalls.push(params);
    if (this.onDeliver) await this.onDeliver();
    if (this.deliverError) throw this.deliverError;
    return { attempted: params.subscribers.length, failed: 0 };
  }
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
}

describe("NotetakerTranscriptWebhookService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let gateway: FakeWebhookGateway;
  let membershipLookup: InMemoryNotetakerMembershipLookup;
  let logger: ReturnType<typeof createLogger>;
  let service: NotetakerTranscriptWebhookService;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    repositories = createInMemoryNotetakerRepositories();
    repositories.store.addBooking(buildBooking());
    gateway = new FakeWebhookGateway(repositories.bookingNotetakerRepository);
    membershipLookup = new InMemoryNotetakerMembershipLookup();
    logger = createLogger();
    service = new NotetakerTranscriptWebhookService({
      sessionRepository: repositories.sessionRepository,
      transcriptRepository: repositories.transcriptRepository,
      summaryRepository: repositories.summaryRepository,
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      webhookGateway: gateway,
      membershipLookup,
      logger,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function seedTranscript(
    params: {
      passages?: NotetakerPassageRecord[];
      resultsDeletedAt?: Date | null;
      colleagueSharingDisclosed?: boolean;
    } = {}
  ): Promise<{ sessionId: string; transcriptId: string }> {
    const session = await repositories.sessionRepository.create({
      bookingId: BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: MEETING_URL,
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      status: "READY",
    });
    if (params.resultsDeletedAt) {
      await repositories.sessionRepository.update(session.id, { resultsDeletedAt: params.resultsDeletedAt });
    }
    if (params.colleagueSharingDisclosed) {
      await repositories.sessionRepository.update(session.id, { colleagueSharingDisclosed: true });
    }
    const transcript = await repositories.transcriptRepository.createIfMissing({
      sessionId: session.id,
      bookingId: BOOKING_ID,
    });
    const passages = params.passages ?? [
      buildPassage({ index: 1, speakerName: null, unknownSpeakerNumber: 2, startMs: 4000, endMs: 9000 }),
      buildPassage({ index: 0 }),
    ];
    await repositories.transcriptRepository.insertPassages(transcript.id, passages);
    await repositories.transcriptRepository.update(transcript.id, {
      language: "en",
      completeness: "COMPLETE",
      durationMs: 9000,
      passageCount: passages.length,
      speakerNamesAvailable: true,
    });
    return { sessionId: session.id, transcriptId: transcript.id };
  }

  function expectNothingLoggedWithText() {
    const calls = [...logger.debug.mock.calls, ...logger.error.mock.calls, ...logger.info.mock.calls];
    expect(JSON.stringify([...calls, ...logger.warn.mock.calls])).not.toContain(SECRET_TOKEN);
  }

  it("claims the transcript once and delivers the booking payload with the notetaker block to every subscriber", async () => {
    const { sessionId, transcriptId } = await seedTranscript();

    await service.sendOnce({ transcriptId });

    expect(gateway.findSubscribersCalls).toEqual([{ userId: ORGANIZER_ID, memberSharingTeamIds: [] }]);
    expect(gateway.buildBookingPayloadCalls).toEqual([
      { bookingId: BOOKING_ID, fallbackVideoCallUrl: MEETING_URL },
    ]);
    expect(gateway.deliverCalls).toHaveLength(1);
    const [delivery] = gateway.deliverCalls;
    expect(delivery.subscribers.map((subscriber) => subscriber.id)).toEqual(["wh-1", "wh-2"]);
    expect(delivery.createdAt).toBe(NOW.toISOString());
    expect(delivery.payload.uid).toBe("booking-uid-1");
    expect(delivery.payload.notetaker).toEqual({
      version: 1,
      sessionId,
      transcriptId,
      language: "en",
      completeness: "COMPLETE",
      durationMs: 9000,
      speakerNamesAvailable: true,
      passages: [
        {
          index: 0,
          speakerKey: "speaker-1",
          speakerName: "Alex",
          unknownSpeakerNumber: null,
          startMs: 0,
          endMs: 1000,
          text: `we shipped ${SECRET_TOKEN} today`,
        },
        {
          index: 1,
          speakerKey: "speaker-1",
          speakerName: null,
          unknownSpeakerNumber: 2,
          startMs: 4000,
          endMs: 9000,
          text: `we shipped ${SECRET_TOKEN} today`,
        },
      ],
      summary: null,
    });
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(true);
    expectNothingLoggedWithText();
  });

  it("does nothing on a second call for the same transcript", async () => {
    const { transcriptId } = await seedTranscript();

    await service.sendOnce({ transcriptId });
    await service.sendOnce({ transcriptId });

    expect(gateway.deliverCalls).toHaveLength(1);
  });

  it("skips a transcript whose results were deleted", async () => {
    const { transcriptId } = await seedTranscript({ resultsDeletedAt: new Date("2026-10-12T10:45:00.000Z") });

    await service.sendOnce({ transcriptId });

    expect(gateway.findSubscribersCalls).toEqual([]);
    expect(gateway.deliverCalls).toEqual([]);
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(false);
  });

  it("skips a transcript without passages", async () => {
    const { transcriptId } = await seedTranscript({ passages: [] });

    await service.sendOnce({ transcriptId });

    expect(gateway.findSubscribersCalls).toEqual([]);
    expect(gateway.deliverCalls).toEqual([]);
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(false);
  });

  it("returns quietly for a missing transcript", async () => {
    await service.sendOnce({ transcriptId: "00000000-0000-4000-8000-999999999999" });

    expect(gateway.findSubscribersCalls).toEqual([]);
    expect(gateway.deliverCalls).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("delivers the meeting payload with its contacts for an ad-hoc booking", async () => {
    repositories.store.addBooking(
      buildBooking({ eventTypeId: null, metadata: { [NOTETAKER_AD_HOC_KEY]: "true" }, attendeeEmails: [] })
    );
    repositories.store.meetingContacts.set(BOOKING_ID, [
      { email: "customer@client.example", name: "Casey Customer", source: "MANUAL" },
    ]);
    const { transcriptId } = await seedTranscript();

    await service.sendOnce({ transcriptId });

    expect(gateway.findSubscribersCalls).toEqual([{ userId: ORGANIZER_ID, memberSharingTeamIds: [] }]);
    expect(gateway.buildBookingPayloadCalls).toEqual([]);
    expect(gateway.buildMeetingPayloadCalls).toEqual([
      { bookingId: BOOKING_ID, fallbackVideoCallUrl: MEETING_URL },
    ]);
    expect(gateway.deliverCalls).toHaveLength(1);
    const { payload } = gateway.deliverCalls[0];
    expect(payload).toMatchObject({
      type: "notetaker_meeting",
      uid: "booking-uid-1",
      bookingId: BOOKING_ID,
      eventTypeId: null,
      source: "ad_hoc",
      organizer: { name: "Organizer", email: "organizer@example.com" },
      attendees: [{ name: "Casey Customer", email: "customer@client.example" }],
      metadata: { videoCallUrl: MEETING_URL },
      notetaker: { transcriptId },
    });
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(true);
    expectNothingLoggedWithText();
  });

  it("delivers the meeting payload for a calendar auto-join booking", async () => {
    repositories.store.addBooking(
      buildBooking({
        eventTypeId: null,
        location: "https://meet.google.com/cal-endr-mtg",
        metadata: { [NOTETAKER_CALENDAR_MEETING_KEY]: "true" },
        attendeeEmails: [],
      })
    );
    repositories.store.meetingContacts.set(BOOKING_ID, [
      { email: "guest@client.example", name: null, source: "CALENDAR" },
    ]);
    const { transcriptId } = await seedTranscript();

    await service.sendOnce({ transcriptId });

    expect(gateway.deliverCalls).toHaveLength(1);
    expect(gateway.deliverCalls[0].payload).toMatchObject({
      source: "calendar_auto_join",
      eventTypeId: null,
      attendees: [{ name: "", email: "guest@client.example" }],
      location: "https://meet.google.com/cal-endr-mtg",
      metadata: { videoCallUrl: "https://meet.google.com/cal-endr-mtg" },
    });
  });

  it("delivers the meeting payload with no attendees when the meeting has no contacts", async () => {
    repositories.store.addBooking(
      buildBooking({ eventTypeId: null, metadata: { [NOTETAKER_AD_HOC_KEY]: "true" }, attendeeEmails: [] })
    );
    const { transcriptId } = await seedTranscript();

    await service.sendOnce({ transcriptId });

    expect(gateway.deliverCalls).toHaveLength(1);
    expect(gateway.deliverCalls[0].payload).toMatchObject({ source: "ad_hoc", attendees: [] });
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(true);
  });

  it("skips a booking without an owner", async () => {
    repositories.store.addBooking(buildBooking({ userId: null }));
    const { transcriptId } = await seedTranscript();

    await service.sendOnce({ transcriptId });

    expect(gateway.findSubscribersCalls).toEqual([]);
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(false);
  });

  describe("team webhooks opted into member meetings", () => {
    function seedTeamBooking(overrides: Partial<InMemoryBookingSeed> = {}) {
      repositories.store.addBooking(
        buildBooking({ teamId: TEAM_ID, teamName: "Sales", sharingMode: "TEAM", ...overrides })
      );
      gateway.teamSubscribers.set(TEAM_ID, [buildSubscriber("wh-team")]);
    }

    function deliveredIds(): string[] {
      return gateway.deliverCalls.flatMap((delivery) =>
        delivery.subscribers.map((subscriber) => subscriber.id)
      );
    }

    it("delivers to the team webhook when the transcript is shared with the team", async () => {
      seedTeamBooking();
      membershipLookup.addMember({ teamId: TEAM_ID, userId: ORGANIZER_ID });
      const { transcriptId } = await seedTranscript({ colleagueSharingDisclosed: true });

      await service.sendOnce({ transcriptId });

      expect(gateway.findSubscribersCalls).toEqual([
        { userId: ORGANIZER_ID, memberSharingTeamIds: [TEAM_ID] },
      ]);
      expect(deliveredIds()).toEqual(["wh-1", "wh-2", "wh-team"]);
    });

    it("delivers to the team webhook for a personal event type shared with its chosen team", async () => {
      seedTeamBooking({ sharingOwnerUserId: ORGANIZER_ID });
      membershipLookup.addMember({ teamId: TEAM_ID, userId: ORGANIZER_ID });
      const { transcriptId } = await seedTranscript({ colleagueSharingDisclosed: true });

      await service.sendOnce({ transcriptId });

      expect(deliveredIds()).toContain("wh-team");
    });

    it("does not deliver to the team webhook when sharing is kept to hosts only", async () => {
      seedTeamBooking({ sharingMode: "HOSTS_ONLY" });
      membershipLookup.addMember({ teamId: TEAM_ID, userId: ORGANIZER_ID });
      const { transcriptId } = await seedTranscript({ colleagueSharingDisclosed: true });

      await service.sendOnce({ transcriptId });

      expect(gateway.findSubscribersCalls).toEqual([{ userId: ORGANIZER_ID, memberSharingTeamIds: [] }]);
      expect(deliveredIds()).toEqual(["wh-1", "wh-2"]);
    });

    it("does not deliver to the team webhook when colleague sharing was not disclosed in the session", async () => {
      seedTeamBooking();
      membershipLookup.addMember({ teamId: TEAM_ID, userId: ORGANIZER_ID });
      const { transcriptId } = await seedTranscript();

      await service.sendOnce({ transcriptId });

      expect(gateway.findSubscribersCalls).toEqual([{ userId: ORGANIZER_ID, memberSharingTeamIds: [] }]);
      expect(deliveredIds()).toEqual(["wh-1", "wh-2"]);
    });

    it("does not deliver to the team webhook when the owner left the team", async () => {
      seedTeamBooking();
      const { transcriptId } = await seedTranscript({ colleagueSharingDisclosed: true });

      await service.sendOnce({ transcriptId });

      expect(deliveredIds()).toEqual(["wh-1", "wh-2"]);
    });

    it("does not deliver to the team webhook when the owner of a personal event type left its chosen team", async () => {
      seedTeamBooking({ sharingOwnerUserId: ORGANIZER_ID });
      membershipLookup.addMember({ teamId: TEAM_ID, userId: ORGANIZER_ID, accepted: false });
      const { transcriptId } = await seedTranscript({ colleagueSharingDisclosed: true });

      await service.sendOnce({ transcriptId });

      expect(deliveredIds()).toEqual(["wh-1", "wh-2"]);
    });

    it("delivers to the user and the team webhook separately and to a webhook found twice once", async () => {
      seedTeamBooking();
      gateway.subscribers = [buildSubscriber("wh-user")];
      gateway.teamSubscribers.set(TEAM_ID, [buildSubscriber("wh-team"), buildSubscriber("wh-user")]);
      membershipLookup.addMember({ teamId: TEAM_ID, userId: ORGANIZER_ID });
      const { transcriptId } = await seedTranscript({ colleagueSharingDisclosed: true });

      await service.sendOnce({ transcriptId });

      expect(gateway.deliverCalls).toHaveLength(1);
      expect(deliveredIds()).toEqual(["wh-user", "wh-team"]);
    });
  });

  it("does not claim the transcript when the owner has no subscribers", async () => {
    gateway.subscribers = [];
    const { transcriptId } = await seedTranscript();

    await service.sendOnce({ transcriptId });

    expect(gateway.buildBookingPayloadCalls).toEqual([]);
    expect(gateway.deliverCalls).toEqual([]);
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(false);
  });

  it("does not claim the transcript when the booking payload cannot be built", async () => {
    gateway.bookingPayload = null;
    const { transcriptId } = await seedTranscript();

    await service.sendOnce({ transcriptId });

    expect(gateway.deliverCalls).toEqual([]);
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(false);
  });

  it("does not deliver when another caller claimed the transcript first", async () => {
    const { transcriptId } = await seedTranscript();
    await repositories.transcriptRepository.claimWebhookDispatch(transcriptId, NOW);

    await service.sendOnce({ transcriptId });

    expect(gateway.buildBookingPayloadCalls).toHaveLength(1);
    expect(gateway.deliverCalls).toEqual([]);
  });

  it("delivers once when two calls race", async () => {
    const { transcriptId } = await seedTranscript();

    await Promise.all([service.sendOnce({ transcriptId }), service.sendOnce({ transcriptId })]);

    expect(gateway.deliverCalls).toHaveLength(1);
  });

  it("swallows a delivery failure and keeps the claim", async () => {
    gateway.deliverError = new Error("network down");
    const { transcriptId } = await seedTranscript();

    await expect(service.sendOnce({ transcriptId })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "Notetaker transcript webhook failed",
      expect.objectContaining({ transcriptId })
    );
    expect(repositories.store.webhookDispatchedTranscriptIds.has(transcriptId)).toBe(true);
    expectNothingLoggedWithText();
  });

  it("sends a READY summary", async () => {
    const { transcriptId } = await seedTranscript();
    await repositories.summaryRepository.upsertPending(transcriptId);
    await repositories.summaryRepository.saveResult(transcriptId, {
      status: "READY",
      language: "en",
      overview: "Overview",
      keyPoints: ["Point"],
      decisions: ["Decision"],
      actionItems: [{ text: "Task", owner: "Ada" }],
      topics: [{ title: "Budget", category: "DECISION", details: ["Agreed"] }],
      formatVersion: 1,
      model: "model",
      generatedAt: NOW,
    });

    await service.sendOnce({ transcriptId });

    expect(gateway.deliverCalls[0].payload.notetaker?.summary).toEqual({
      status: "READY",
      language: "en",
      overview: "Overview",
      keyPoints: ["Point"],
      decisions: ["Decision"],
      actionItems: [{ text: "Task", owner: "Ada" }],
      topics: [{ title: "Budget", category: "DECISION", details: ["Agreed"] }],
    });
  });

  it("sends a null summary for NOT_ENOUGH_CONTENT", async () => {
    const { transcriptId } = await seedTranscript();
    await repositories.summaryRepository.upsertPending(transcriptId);
    await repositories.summaryRepository.setStatus(transcriptId, "NOT_ENOUGH_CONTENT", null);

    await service.sendOnce({ transcriptId });

    expect(gateway.deliverCalls).toHaveLength(1);
    expect(gateway.deliverCalls[0].payload.notetaker?.summary).toBeNull();
  });
});
