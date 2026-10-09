import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  INotetakerCalendarGuestGateway,
  NotetakerCalendarGuestOutcome,
} from "../calendar/INotetakerCalendarGuestGateway";
import type { NotetakerConfig } from "../lib/config";
import { getNotetakerConfig } from "../lib/config";
import type { NotetakerBookingReferenceRecord } from "../repositories/interfaces/IBookingNotetakerRepository";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import type { INotetakerCalendarInviteServiceDeps } from "./NotetakerCalendarInviteService";
import {
  NOTETAKER_CALENDAR_INVITE_TIMEOUT_MS,
  NotetakerCalendarInviteService,
} from "./NotetakerCalendarInviteService";

const BOOKING_ID = 100;
const SESSION_ID = "session-1";
const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const BOT_EMAIL = "notetaker.bot@example.com";
const EVENT_ID = "google-event-1";
const CALENDAR_ID = "host@example.com";
const FINISHED = "Notetaker calendar invite finished";
const DID_NOT_SUCCEED = "Notetaker calendar invite did not succeed; the notetaker will ask to join";

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  ...overrides,
});

const EMAIL_ENV = "  Notetaker.Bot@Example.com ";
const configured = getNotetakerConfig(
  env({ NOTETAKER_BOT_PROVIDER: "self_hosted", NOTETAKER_GOOGLE_ACCOUNT_EMAIL: EMAIL_ENV })
);

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
}

class RecordingGuestGateway implements INotetakerCalendarGuestGateway {
  calls: Parameters<INotetakerCalendarGuestGateway["ensureGuest"]>[0][] = [];
  respond: (callIndex: number) => Promise<NotetakerCalendarGuestOutcome> = async () => "ADDED";

  respondWith(outcomes: NotetakerCalendarGuestOutcome[]): void {
    this.respond = async (callIndex) => outcomes[callIndex] ?? "ADDED";
  }

  async ensureGuest(
    params: Parameters<INotetakerCalendarGuestGateway["ensureGuest"]>[0]
  ): Promise<NotetakerCalendarGuestOutcome> {
    this.calls.push(params);
    return this.respond(this.calls.length - 1);
  }
}

function reference(
  overrides: Partial<NotetakerBookingReferenceRecord> = {}
): NotetakerBookingReferenceRecord {
  return {
    type: "google_calendar",
    uid: EVENT_ID,
    externalCalendarId: CALENDAR_ID,
    credentialId: 7,
    delegationCredentialId: null,
    ...overrides,
  };
}

describe("NotetakerCalendarInviteService", () => {
  let logger: ReturnType<typeof createLogger>;
  let gateway: RecordingGuestGateway;
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let repositoryCalls: Parameters<
    INotetakerCalendarInviteServiceDeps["bookingNotetakerRepository"]["findReferencesByBookingIdAndType"]
  >[0][];
  let countingRepository: INotetakerCalendarInviteServiceDeps["bookingNotetakerRepository"];

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createLogger();
    gateway = new RecordingGuestGateway();
    repositories = createInMemoryNotetakerRepositories();
    repositoryCalls = [];
    countingRepository = {
      findReferencesByBookingIdAndType: async (params) => {
        repositoryCalls.push(params);
        return repositories.bookingNotetakerRepository.findReferencesByBookingIdAndType(params);
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildService(
    config: NotetakerConfig = configured,
    overrides: Partial<INotetakerCalendarInviteServiceDeps> = {}
  ) {
    return new NotetakerCalendarInviteService({
      bookingNotetakerRepository: countingRepository,
      calendarGuestGateway: gateway,
      config,
      logger,
      ...overrides,
    });
  }

  function invite(
    platform: NotetakerPlatformDto = "GOOGLE_MEET",
    config: NotetakerConfig = configured,
    overrides: Partial<INotetakerCalendarInviteServiceDeps> = {}
  ) {
    return buildService(config, overrides).ensureBotInvited({
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      platform,
      meetingUrl: MEET_LINK,
    });
  }

  function expectNothingLogged() {
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  }

  function seed(...records: NotetakerBookingReferenceRecord[]) {
    repositories.store.setReferences(BOOKING_ID, records);
  }

  it("returns NOT_CONFIGURED when the bot's Google account email is unset", async () => {
    const config = getNotetakerConfig(env({ NOTETAKER_BOT_PROVIDER: "self_hosted" }));
    expect(config.googleAccountEmail).toBeNull();
    seed(reference());

    await expect(invite("GOOGLE_MEET", config)).resolves.toBe("NOT_CONFIGURED");

    expect(repositoryCalls).toEqual([]);
    expect(gateway.calls).toEqual([]);
    expectNothingLogged();
  });

  it.each([
    ["FAKE", env({ NOTETAKER_BOT_PROVIDER: "fake", NOTETAKER_GOOGLE_ACCOUNT_EMAIL: BOT_EMAIL })],
    ["RECALL", env({ NOTETAKER_BOT_PROVIDER: "recall", NOTETAKER_GOOGLE_ACCOUNT_EMAIL: BOT_EMAIL })],
    ["no provider", env({ NODE_ENV: "production", NOTETAKER_GOOGLE_ACCOUNT_EMAIL: BOT_EMAIL })],
  ])("returns NOT_CONFIGURED for %s even with the email set", async (_label, environment) => {
    const config = getNotetakerConfig(environment);
    expect(config.googleAccountEmail).toBe(BOT_EMAIL);
    seed(reference());

    await expect(invite("GOOGLE_MEET", config)).resolves.toBe("NOT_CONFIGURED");

    expect(repositoryCalls).toEqual([]);
    expect(gateway.calls).toEqual([]);
    expectNothingLogged();
  });

  it("returns NOT_GOOGLE_MEET for a Microsoft Teams meeting", async () => {
    seed(reference());

    await expect(invite("MICROSOFT_TEAMS")).resolves.toBe("NOT_GOOGLE_MEET");

    expect(repositoryCalls).toEqual([]);
    expect(gateway.calls).toEqual([]);
    expectNothingLogged();
  });

  it("returns NO_CALENDAR_EVENT when the booking has no references", async () => {
    await expect(invite()).resolves.toBe("NO_CALENDAR_EVENT");

    expect(repositoryCalls).toEqual([{ bookingId: BOOKING_ID, type: "google_calendar" }]);
    expect(gateway.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(FINISHED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "NO_CALENDAR_EVENT",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns NO_CALENDAR_EVENT when only a google_meet_video reference exists", async () => {
    seed(reference({ type: "google_meet_video" }));

    await expect(invite()).resolves.toBe("NO_CALENDAR_EVENT");

    expect(gateway.calls).toEqual([]);
  });

  it("returns NO_CALENDAR_EVENT when every google_calendar row has an empty uid", async () => {
    seed(reference({ uid: "" }), reference({ uid: "", credentialId: 8 }));

    await expect(invite()).resolves.toBe("NO_CALENDAR_EVENT");

    expect(gateway.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["only a delegation credential", { credentialId: null, delegationCredentialId: "delegation-1" }],
    ["credential id 0", { credentialId: 0 }],
    ["credential id -1", { credentialId: -1 }],
  ])("returns CREDENTIAL_UNAVAILABLE without calling Google for %s", async (_label, overrides) => {
    seed(reference(overrides));

    await expect(invite()).resolves.toBe("CREDENTIAL_UNAVAILABLE");

    expect(gateway.calls).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(DID_NOT_SUCCEED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "CREDENTIAL_UNAVAILABLE",
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("returns INVITED and adds the bot to the event on ADDED", async () => {
    seed(reference());

    await expect(invite()).resolves.toBe("INVITED");

    expect(gateway.calls).toEqual([
      {
        event: { credentialId: 7, eventId: EVENT_ID, calendarId: CALENDAR_ID },
        guestEmail: BOT_EMAIL,
        meetingUrl: MEET_LINK,
      },
    ]);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(FINISHED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "INVITED",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("passes a null external calendar id as a null calendarId", async () => {
    seed(reference({ externalCalendarId: null }));

    await invite();

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0].event.calendarId).toBeNull();
  });

  it("returns ALREADY_INVITED on ALREADY_PRESENT", async () => {
    seed(reference());
    gateway.respondWith(["ALREADY_PRESENT"]);

    await expect(invite()).resolves.toBe("ALREADY_INVITED");

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(FINISHED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "ALREADY_INVITED",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns NOT_THE_MEETING_EVENT with an info line for a single row", async () => {
    seed(reference());
    gateway.respondWith(["NOT_THE_MEETING_EVENT"]);

    await expect(invite()).resolves.toBe("NOT_THE_MEETING_EVENT");

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(FINISHED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "NOT_THE_MEETING_EVENT",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns without a message when Google reports the credential unavailable", async () => {
    seed(reference());
    gateway.respondWith(["CREDENTIAL_UNAVAILABLE"]);

    await expect(invite()).resolves.toBe("CREDENTIAL_UNAVAILABLE");

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(DID_NOT_SUCCEED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "CREDENTIAL_UNAVAILABLE",
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("tries the next reference when the first is not the meeting's event", async () => {
    seed(
      reference({ credentialId: 7, uid: "event-a" }),
      reference({ credentialId: 8, uid: "event-b", externalCalendarId: null })
    );
    gateway.respondWith(["NOT_THE_MEETING_EVENT", "ADDED"]);

    await expect(invite()).resolves.toBe("INVITED");

    expect(gateway.calls).toEqual([
      {
        event: { credentialId: 7, eventId: "event-a", calendarId: CALENDAR_ID },
        guestEmail: BOT_EMAIL,
        meetingUrl: MEET_LINK,
      },
      {
        event: { credentialId: 8, eventId: "event-b", calendarId: null },
        guestEmail: BOT_EMAIL,
        meetingUrl: MEET_LINK,
      },
    ]);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("stops at the first success", async () => {
    seed(reference({ uid: "event-a" }), reference({ credentialId: 8, uid: "event-b" }));
    gateway.respondWith(["ADDED", "ADDED"]);

    await expect(invite()).resolves.toBe("INVITED");

    expect(gateway.calls).toHaveLength(1);
  });

  it.each([
    [["NOT_THE_MEETING_EVENT", "CREDENTIAL_UNAVAILABLE"] as const, "CREDENTIAL_UNAVAILABLE"],
    [["CREDENTIAL_UNAVAILABLE", "NOT_THE_MEETING_EVENT"] as const, "NOT_THE_MEETING_EVENT"],
  ])("returns the last remembered outcome for %j", async (outcomes, expected) => {
    seed(reference({ uid: "event-a" }), reference({ credentialId: 8, uid: "event-b" }));
    gateway.respondWith([...outcomes]);

    await expect(invite()).resolves.toBe(expected);

    expect(gateway.calls).toHaveLength(2);
  });

  it("skips unusable rows without remembering them", async () => {
    seed(
      reference({ uid: "event-a", credentialId: null, delegationCredentialId: "delegation-1" }),
      reference({ credentialId: 8, uid: "event-b" })
    );
    gateway.respondWith(["NOT_THE_MEETING_EVENT"]);

    await expect(invite()).resolves.toBe("NOT_THE_MEETING_EVENT");
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0].event.eventId).toBe("event-b");
  });

  it("lets a usable row succeed after an unusable one", async () => {
    seed(
      reference({ uid: "event-a", credentialId: null, delegationCredentialId: "delegation-1" }),
      reference({ credentialId: 8, uid: "event-b" })
    );

    await expect(invite()).resolves.toBe("INVITED");
    expect(gateway.calls).toHaveLength(1);
  });

  it("resolves FAILED and logs the message when the gateway rejects", async () => {
    seed(reference());
    gateway.respond = async () => {
      throw new Error("google unavailable");
    };

    await expect(invite()).resolves.toBe("FAILED");

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(DID_NOT_SUCCEED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "FAILED",
      message: "google unavailable",
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("resolves FAILED when the repository rejects", async () => {
    const failingRepository: INotetakerCalendarInviteServiceDeps["bookingNotetakerRepository"] = {
      findReferencesByBookingIdAndType: async () => {
        throw new Error("database unavailable");
      },
    };

    await expect(
      invite("GOOGLE_MEET", configured, { bookingNotetakerRepository: failingRepository })
    ).resolves.toBe("FAILED");

    expect(gateway.calls).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(DID_NOT_SUCCEED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "FAILED",
      message: "database unavailable",
    });
  });

  it("logs 'unknown error' when the rejection is not an Error", async () => {
    seed(reference());
    gateway.respond = () => Promise.reject("boom");

    await expect(invite()).resolves.toBe("FAILED");

    expect(logger.warn).toHaveBeenCalledWith(DID_NOT_SUCCEED, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
      outcome: "FAILED",
      message: "unknown error",
    });
  });

  it("resolves FAILED after the timeout when the gateway never settles", async () => {
    seed(reference());
    gateway.respond = () => new Promise<NotetakerCalendarGuestOutcome>(() => {});
    const settled = vi.fn();

    const pending = invite();
    void pending.then(settled);

    await vi.advanceTimersByTimeAsync(NOTETAKER_CALENDAR_INVITE_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe("FAILED");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      DID_NOT_SUCCEED,
      expect.objectContaining({
        bookingId: BOOKING_ID,
        sessionId: SESSION_ID,
        outcome: "FAILED",
        message: expect.any(String),
      })
    );
    expect(NOTETAKER_CALENDAR_INVITE_TIMEOUT_MS).toBe(8_000);
  });

  it("clears the timeout timer after a successful call", async () => {
    seed(reference());

    await expect(invite()).resolves.toBe("INVITED");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout timer after a rejected call", async () => {
    seed(reference());
    gateway.respond = async () => {
      throw new Error("google unavailable");
    };

    await expect(invite()).resolves.toBe("FAILED");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("never logs the meeting link, event, calendar or bot email", async () => {
    seed(reference());
    await invite();

    gateway.respond = async () => {
      throw new Error("google unavailable");
    };
    await invite();

    gateway.respond = async () => "CREDENTIAL_UNAVAILABLE";
    await invite();

    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    for (const secret of [MEET_LINK, "meet.google.com", BOT_EMAIL, EVENT_ID, CALENDAR_ID]) {
      expect(logged).not.toContain(secret);
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
