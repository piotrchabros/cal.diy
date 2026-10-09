/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// TODO: Bring this test back with the correct setup (no illegal imports)
// NOTE: All imports except vitest are deferred to inside the skipped describe blocks
// to prevent module loading side effects during test collection (which can cause
// "Closing rpc while fetch was pending" errors from watchlist module imports)
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

describe.skip("getLocationForOrganizerDefaultConferencingAppInEvtFormat", () => {
  const mockTranslate = vi.fn((key: string) => key);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("Dynamic link apps", () => {
    test("should return the app type for Zoom", () => {
      const organizer = {
        name: "Test Organizer",
        metadata: {
          defaultConferencingApp: {
            appSlug: "zoom",
          },
        },
      };

      const result = getLocationForOrganizerDefaultConferencingAppInEvtFormat({
        organizer,
        loggedInUserTranslate: mockTranslate,
      });

      expect(result).toBe("integrations:zoom");
    });

    test("should return the app type for Google Meet", () => {
      const organizer = {
        name: "Test Organizer",
        metadata: {
          defaultConferencingApp: {
            appSlug: "google-meet",
          },
        },
      };

      const result = getLocationForOrganizerDefaultConferencingAppInEvtFormat({
        organizer,
        loggedInUserTranslate: mockTranslate,
      });

      expect(result).toBe("integrations:google:meet");
    });
  });

  describe("Static link apps", () => {
    test("should return the app type for Campfire", () => {
      const organizer = {
        name: "Test Organizer",
        metadata: {
          defaultConferencingApp: {
            appSlug: "campfire",
            appLink: "https://campfire.com",
          },
        },
      };
      const result = getLocationForOrganizerDefaultConferencingAppInEvtFormat({
        organizer,
        loggedInUserTranslate: mockTranslate,
      });
      expect(result).toBe("https://campfire.com");
    });
  });

  describe("Error handling", () => {
    test("should throw a UserError if defaultConferencingApp is not set", () => {
      const organizer = {
        name: "Test Organizer",
        metadata: null,
      };

      expect(() =>
        getLocationForOrganizerDefaultConferencingAppInEvtFormat({
          organizer,
          loggedInUserTranslate: mockTranslate,
        })
      ).toThrow(UserError);
      expect(mockTranslate).toHaveBeenCalledWith("organizer_default_conferencing_app_not_found", {
        organizer: "Test Organizer",
      });
    });

    test("should throw a SystemError if the app is not found", () => {
      const organizer = {
        name: "Test Organizer",
        metadata: {
          defaultConferencingApp: {
            appSlug: "invalid-app",
          },
        },
      };

      expect(() =>
        getLocationForOrganizerDefaultConferencingAppInEvtFormat({
          organizer,
          loggedInUserTranslate: mockTranslate,
        })
      ).toThrow(SystemError);
    });

    test("should throw a SystemError for static link apps if appLink is missing", () => {
      const organizer = {
        name: "Test Organizer",
        metadata: {
          defaultConferencingApp: {
            appSlug: "no-link-app",
          },
        },
      };

      expect(() =>
        getLocationForOrganizerDefaultConferencingAppInEvtFormat({
          organizer,
          loggedInUserTranslate: mockTranslate,
        })
      ).toThrow(SystemError);
    });
  });
});

describe.skip("editLocation.handler", () => {
  describe("Changing organizer default conferencing app", () => {
    test("should update the booking location when organizer's default conferencing app changes", async ({
      emails,
    }) => {
      const scenarioData = {
        organizer: getOrganizer({
          name: "Organizer",
          email: "organizer@example.com",
          id: 101,
          schedules: [TestData.schedules.IstWorkHours],
          credentials: [getZoomAppCredential()],
          selectedCalendars: [TestData.selectedCalendars.google],
          destinationCalendar: {
            integration: "google_calendar",
            externalId: "organizer@google-calendar.com",
          },
          metadata: {
            defaultConferencingApp: {
              appSlug: "campfire",
              appLink: "https://campfire.com",
            },
          },
        }),
        eventTypes: [
          {
            id: 1,
            slotInterval: 45,
            length: 45,
            users: [{ id: 101 }],
          },
        ],
        bookings: [
          {
            id: 1,
            uid: "booking-1",
            eventTypeId: 1,
            status: BookingStatus.ACCEPTED,
            startTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            endTime: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
            userId: 101,
            attendees: [
              {
                id: 102,
                name: "Attendee 1",
                email: "attendee1@example.com",
                timeZone: "Asia/Kolkata",
              },
            ],
          },
        ],
        // biome-ignore lint/complexity/useLiteralKeys: app keys contain hyphens
        apps: [TestData.apps["zoom"], TestData.apps["google-meet"]],
      };

      await createBookingScenario(getScenarioData(scenarioData));

      const booking = await prisma.booking.findFirst({
        where: {
          uid: scenarioData.bookings[0].uid,
        },
        include: {
          // eslint-disable-next-line @calcom/eslint/no-prisma-include-true
          user: true,
          // eslint-disable-next-line @calcom/eslint/no-prisma-include-true
          attendees: true,
          // eslint-disable-next-line @calcom/eslint/no-prisma-include-true
          references: true,
        },
      });

      const organizerUser = await prisma.user.findFirst({
        where: {
          id: scenarioData.organizer.id,
        },
      });

      expect(booking).not.toBeNull();

      // Simulate changing the organizer's default conferencing app to Google Meet
      const updatedOrganizer = {
        ...booking.user,
        metadata: {
          ...booking.user.metadata,
          defaultConferencingApp: {
            appSlug: "google-meet",
          },
        },
      };

      await editLocationHandler({
        ctx: {
          booking,
          user: organizerUser,
        },
        input: {
          newLocation: "conferencing",
        },
        actionSource: "WEBAPP",
      });

      const updatedBooking = await prisma.booking.findFirstOrThrow({
        where: {
          uid: scenarioData.bookings[0].uid,
        },
      });

      expect(updatedBooking.location).toBe("https://campfire.com");

      expectSuccesfulLocationChangeEmails({
        emails,
        organizer: organizerUser,
        location: {
          href: "https://campfire.com",
          linkText: "Link",
        },
      });
    });
  });
});

const mocks = vi.hoisted(() => ({
  findByIdOrThrow: vi.fn(),
  getTranslation: vi.fn(),
  buildCalEventFromBooking: vi.fn(),
  getUsersCredentials: vi.fn(),
  updateLocation: vi.fn(),
  getVideoCallUrlFromCalEvent: vi.fn(),
  updateLocationById: vi.fn(),
  sendLocationChangeEmailsAndSMS: vi.fn(),
  getNotetakerChoiceService: vi.fn(),
  getNotetakerDispatchService: vi.fn(),
  onBookingLocationChanged: vi.fn(),
  stopForBooking: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@calcom/app-store/delegationCredential", () => ({
  getUsersCredentialsIncludeServiceAccountKey: mocks.getUsersCredentials,
}));
vi.mock("@calcom/app-store/locations", () => ({
  OrganizerDefaultConferencingAppType: "conferencing",
  getLocationByType: vi.fn(),
}));
vi.mock("@calcom/app-store/utils", () => ({ getAppFromSlug: vi.fn() }));
vi.mock("@calcom/emails/email-manager", () => ({
  sendLocationChangeEmailsAndSMS: mocks.sendLocationChangeEmailsAndSMS,
}));
vi.mock("@calcom/features/bookings/lib/EventManager", () => ({
  default: class {
    updateLocation = mocks.updateLocation;
  },
}));
vi.mock("@calcom/features/bookings/repositories/BookingRepository", () => ({
  BookingRepository: class {
    updateLocationById = mocks.updateLocationById;
  },
}));
vi.mock("@calcom/features/credentials/repositories/CredentialRepository", () => ({
  CredentialRepository: { findFirstByIdWithKeyAndUser: vi.fn() },
}));
vi.mock("@calcom/features/credentials/services/CredentialAccessService", () => ({
  CredentialAccessService: class {
    ensureAccessible = vi.fn();
  },
}));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    findByIdOrThrow = mocks.findByIdOrThrow;
  },
}));
vi.mock("@calcom/lib/buildCalEventFromBooking", () => ({
  buildCalEventFromBooking: mocks.buildCalEventFromBooking,
}));
vi.mock("@calcom/lib/CalEventParser", () => ({
  getVideoCallUrlFromCalEvent: mocks.getVideoCallUrlFromCalEvent,
}));
vi.mock("@calcom/lib/logger", () => {
  const stub = {
    error: mocks.logError,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    getSubLogger: () => stub,
  };
  return { default: stub };
});
vi.mock("@calcom/i18n/server", () => ({ getTranslation: mocks.getTranslation }));
vi.mock("@calcom/prisma", () => ({ prisma: {}, default: {} }));
vi.mock("@calcom/features/notetaker/di/NotetakerChoiceService.container", () => ({
  getNotetakerChoiceService: mocks.getNotetakerChoiceService,
}));
vi.mock("@calcom/features/notetaker/di/NotetakerDispatchService.container", () => ({
  getNotetakerDispatchService: mocks.getNotetakerDispatchService,
}));

describe("editLocationHandler notetaker hook", () => {
  const NEW_LOCATION = "https://example.com/room";
  const NOTETAKER_LOG = "Error applying the location change to the notetaker";
  const booking = {
    id: 42,
    uid: "booking-uid-42",
    userId: 101,
    location: "integrations:google:meet",
    metadata: null,
    responses: null,
    references: [],
    user: { profiles: [] },
    eventType: { metadata: null },
  };
  const user = { id: 101, email: "organizer@example.com", locale: "en" };
  const evt = { location: NEW_LOCATION, iCalSequence: 0 };

  let editLocationHandler: typeof import("./editLocation.handler").editLocationHandler;

  const runWith = (handler) =>
    handler({
      ctx: { booking, user },
      input: { newLocation: NEW_LOCATION },
      actionSource: "WEBAPP",
    });
  const run = () => runWith(editLocationHandler);

  const expectLocationUpdatedDespiteNotetakerFailure = async (result, errorText) => {
    expect(result).toEqual({ message: "Location updated" });
    expect(mocks.sendLocationChangeEmailsAndSMS).toHaveBeenCalledTimes(1);
    expect(mocks.sendLocationChangeEmailsAndSMS).toHaveBeenCalledWith(
      expect.objectContaining({ location: NEW_LOCATION }),
      null
    );
    const expectedDetail = errorText === undefined ? expect.any(String) : expect.stringContaining(errorText);
    expect(mocks.logError).toHaveBeenCalledWith(NOTETAKER_LOG, expectedDetail);
  };

  beforeAll(async () => {
    ({ editLocationHandler } = await import("./editLocation.handler"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByIdOrThrow.mockResolvedValue({ id: 101, name: "Organizer", metadata: null });
    mocks.getTranslation.mockResolvedValue((key) => key);
    mocks.buildCalEventFromBooking.mockResolvedValue(evt);
    mocks.getUsersCredentials.mockResolvedValue([]);
    mocks.updateLocation.mockResolvedValue({
      results: [{ success: true, updatedEvent: {} }],
      referencesToCreate: [],
    });
    mocks.getVideoCallUrlFromCalEvent.mockReturnValue(undefined);
    mocks.updateLocationById.mockResolvedValue(undefined);
    mocks.sendLocationChangeEmailsAndSMS.mockResolvedValue(undefined);
    mocks.stopForBooking.mockResolvedValue(undefined);
    mocks.getNotetakerChoiceService.mockReturnValue({
      onBookingLocationChanged: mocks.onBookingLocationChanged,
    });
    mocks.getNotetakerDispatchService.mockReturnValue({ stopForBooking: mocks.stopForBooking });
    mocks.onBookingLocationChanged.mockResolvedValue({ turnedOff: false });
  });

  test("applies the location change to the notetaker once, after the location is saved", async () => {
    const result = await run();

    expect(result).toEqual({ message: "Location updated" });
    expect(mocks.onBookingLocationChanged).toHaveBeenCalledTimes(1);
    expect(mocks.onBookingLocationChanged).toHaveBeenCalledWith({ bookingId: 42 });
    expect(mocks.updateLocationById.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.onBookingLocationChanged.mock.invocationCallOrder[0]
    );
  });

  test("stops the notetaker with DISABLED when the location change turned it off", async () => {
    mocks.onBookingLocationChanged.mockResolvedValue({ turnedOff: true });

    await run();

    expect(mocks.stopForBooking).toHaveBeenCalledTimes(1);
    expect(mocks.stopForBooking).toHaveBeenCalledWith({
      bookingUid: "booking-uid-42",
      reason: "DISABLED",
    });
    expect(mocks.onBookingLocationChanged.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stopForBooking.mock.invocationCallOrder[0]
    );
  });

  test("does not stop the notetaker when the location change left it on", async () => {
    await run();

    expect(mocks.onBookingLocationChanged).toHaveBeenCalledTimes(1);
    expect(mocks.stopForBooking).not.toHaveBeenCalled();
    expect(mocks.getNotetakerDispatchService).not.toHaveBeenCalled();
  });

  test("still updates the location when the choice service getter throws", async () => {
    mocks.getNotetakerChoiceService.mockImplementation(() => {
      throw new Error("Invalid NOTETAKER_JOIN_LEAD_SECONDS");
    });

    const result = await run();

    await expectLocationUpdatedDespiteNotetakerFailure(result, "Invalid NOTETAKER_JOIN_LEAD_SECONDS");
    expect(mocks.getNotetakerChoiceService).toHaveBeenCalledTimes(1);
    expect(mocks.onBookingLocationChanged).not.toHaveBeenCalled();
  });

  test("still updates the location when onBookingLocationChanged rejects", async () => {
    mocks.onBookingLocationChanged.mockRejectedValue(new Error("db down"));

    const result = await run();

    await expectLocationUpdatedDespiteNotetakerFailure(result, "db down");
    expect(mocks.onBookingLocationChanged).toHaveBeenCalledTimes(1);
    expect(mocks.stopForBooking).not.toHaveBeenCalled();
  });

  test("still updates the location when stopForBooking rejects", async () => {
    mocks.onBookingLocationChanged.mockResolvedValue({ turnedOff: true });
    mocks.stopForBooking.mockRejectedValue(new Error("stop failed"));

    const result = await run();

    await expectLocationUpdatedDespiteNotetakerFailure(result, "stop failed");
  });

  test("still updates the location when the dispatch service getter throws", async () => {
    mocks.onBookingLocationChanged.mockResolvedValue({ turnedOff: true });
    mocks.getNotetakerDispatchService.mockImplementation(() => {
      throw new Error("Invalid NOTETAKER_BOT_TOKEN");
    });

    const result = await run();

    await expectLocationUpdatedDespiteNotetakerFailure(result, "Invalid NOTETAKER_BOT_TOKEN");
    expect(mocks.stopForBooking).not.toHaveBeenCalled();
  });

  test("still updates the location when the choice container module fails to load", async () => {
    const choiceContainer = "@calcom/features/notetaker/di/NotetakerChoiceService.container";
    vi.resetModules();
    vi.doMock(choiceContainer, () => {
      throw new Error("import failed");
    });
    try {
      const { editLocationHandler: freshHandler } = await import("./editLocation.handler");

      const result = await runWith(freshHandler);

      // vitest wraps a throwing mock factory in its own error and keeps the original only as `cause`,
      // which the logged string does not include, so the original message cannot be asserted here.
      await expectLocationUpdatedDespiteNotetakerFailure(result);
    } finally {
      vi.doMock(choiceContainer, () => ({
        getNotetakerChoiceService: mocks.getNotetakerChoiceService,
      }));
      vi.resetModules();
    }
  });
});
