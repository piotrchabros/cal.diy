import prismock from "@calcom/testing/lib/__mocks__/prisma";
import {
  createBookingScenario,
  createOrganization,
  getBooker,
  getDate,
  getOrganizer,
  getScenarioData,
  TestData,
} from "@calcom/testing/lib/bookingScenario/bookingScenario";
import process from "node:process";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import type { RequestOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import {
  getMockRequestDataForBooking,
  getMockRequestDataForDynamicGroupBooking,
} from "@calcom/testing/lib/bookingScenario/getMockRequestDataForBooking";
import { setupAndTeardown } from "@calcom/testing/lib/bookingScenario/setupAndTeardown";
import { test } from "@calcom/testing/lib/fixtures/fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { getNewBookingHandler } from "./getNewBookingHandler";

const { mockResolveBookingHostOrganization, mockGetBaseUrl } = vi.hoisted(() => ({
  mockResolveBookingHostOrganization: vi.fn(),
  mockGetBaseUrl: vi.fn(),
}));

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => {
  const fallback = async () => "http://localhost:3000";
  return {
    getOrganizationUrlService: () => ({
      getBaseUrl: mockGetBaseUrl,
      getBaseUrlForUser: fallback,
      getBaseUrlForTeam: fallback,
      getBaseUrlForEmail: fallback,
    }),
  };
});

vi.mock("@calcom/features/organizations/lib/resolveBookingHostOrganization", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@calcom/features/organizations/lib/resolveBookingHostOrganization")
    >();
  return {
    ...actual,
    resolveBookingHostOrganization: mockResolveBookingHostOrganization,
  };
});

const timeout = process.env.CI ? 5000 : 20000;
// The booking service module graph takes ~20s to import cold; loading it here keeps that cost out of
// the first test's timeout, where a timed-out run would keep creating bookings into the next test.
const moduleWarmupTimeout = 120000;

const hostOrganization: RequestOrganizationDto = {
  id: 1,
  slug: "acme",
  domain: "acme.example.com",
  isDefault: false,
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mockGetBaseUrl.mockImplementation(async ({ organizationId }: { organizationId?: number | null }) =>
    organizationId ? `https://org${organizationId}.example.com` : "http://localhost:3000"
  );
});

async function createOrganizerEventScenario({
  organizationId,
  withOrganizationProfile = false,
}: {
  organizationId: number | null;
  withOrganizationProfile?: boolean;
}) {
  const organizer = getOrganizer({
    name: "Organizer",
    email: "organizer@example.com",
    id: 101,
    organizationId,
    schedules: [TestData.schedules.IstWorkHours],
  });

  await createBookingScenario(
    getScenarioData(
      {
        eventTypes: [
          {
            id: 1,
            slotInterval: 30,
            length: 30,
            owner: 101,
            users: [{ id: 101 }],
          },
        ],
        organizer,
      },
      withOrganizationProfile ? { id: organizationId } : null
    )
  );
}

function getBookingData() {
  const booker = getBooker({ email: "booker@example.com", name: "Booker" });
  return getMockRequestDataForBooking({
    data: {
      eventTypeId: 1,
      responses: {
        email: booker.email,
        name: booker.name,
        location: { optionValue: "", value: "New York" },
      },
    },
  });
}

describe("handleNewBooking organization host check", () => {
  setupAndTeardown();

  beforeAll(async () => {
    await import("@calcom/features/bookings/di/RegularBookingService.container");
  }, moduleWarmupTimeout);

  test(
    "rejects booking an event type of another organization on the host organization's domain",
    async () => {
      const handleNewBooking = getNewBookingHandler();
      mockResolveBookingHostOrganization.mockResolvedValue({ orgSlug: "acme", hostOrganization });
      await createOrganizerEventScenario({ organizationId: 2 });

      await expect(
        handleNewBooking({ bookingData: getBookingData(), hostname: "acme.example.com" })
      ).rejects.toThrow("event_not_found");

      expect(await prismock.booking.findMany({ where: { eventTypeId: 1 } })).toHaveLength(0);
      expect(mockResolveBookingHostOrganization).toHaveBeenCalledWith({
        hostname: "acme.example.com",
        forcedSlug: undefined,
        isPlatform: false,
      });
    },
    timeout
  );

  test(
    "skips the host organization check when the caller asks for it (API v2)",
    async () => {
      const handleNewBooking = getNewBookingHandler();
      mockResolveBookingHostOrganization.mockResolvedValue({ orgSlug: "acme", hostOrganization });
      await createOrganizerEventScenario({ organizationId: 2 });

      const createdBooking = await handleNewBooking({
        bookingData: getBookingData(),
        hostname: "localhost:5555",
        skipHostOrganizationCheck: true,
      });

      expect(createdBooking.uid).toBeTruthy();
      expect(mockResolveBookingHostOrganization).not.toHaveBeenCalled();
    },
    timeout
  );

  test(
    "runs the host organization check for API v1 bookings too",
    async () => {
      const { getRegularBookingService } = await import(
        "@calcom/features/bookings/di/RegularBookingService.container"
      );
      const { default: getBookingDataSchema } = await import("../../getBookingDataSchema");
      mockResolveBookingHostOrganization.mockResolvedValue({ orgSlug: "acme", hostOrganization });
      await createOrganizerEventScenario({ organizationId: 2 });

      await expect(
        getRegularBookingService().createBookingForApiV1({
          bookingData: getBookingData(),
          bookingMeta: { hostname: "acme.example.com" },
          bookingDataSchemaGetter: getBookingDataSchema,
        })
      ).rejects.toThrow("event_not_found");

      expect(await prismock.booking.findMany({ where: { eventTypeId: 1 } })).toHaveLength(0);
    },
    timeout
  );

  test(
    "creates the booking when the event type belongs to the host organization",
    async () => {
      const handleNewBooking = getNewBookingHandler();
      mockResolveBookingHostOrganization.mockResolvedValue({ orgSlug: "acme", hostOrganization });
      await createOrganizerEventScenario({ organizationId: 1 });

      const createdBooking = await handleNewBooking({
        bookingData: getBookingData(),
        hostname: "acme.example.com",
      });

      expect(createdBooking.uid).toBeTruthy();
      expect(await prismock.booking.findMany({ where: { uid: createdBooking.uid } })).toHaveLength(1);
    },
    timeout
  );

  test(
    "builds the booking's bookerUrl on the organizer's organization",
    async () => {
      const handleNewBooking = getNewBookingHandler();
      const org = await createOrganization({ name: "Acme", slug: "acme" });
      mockResolveBookingHostOrganization.mockResolvedValue({
        orgSlug: "acme",
        hostOrganization: { ...hostOrganization, id: org.id },
      });
      await createOrganizerEventScenario({ organizationId: org.id, withOrganizationProfile: true });

      const createdBooking = await handleNewBooking({
        bookingData: getBookingData(),
        hostname: "acme.example.com",
      });

      expect(createdBooking.uid).toBeTruthy();
      expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: org.id });
    },
    timeout
  );

  test(
    "creates the booking when no host organization is resolved",
    async () => {
      const handleNewBooking = getNewBookingHandler();
      mockResolveBookingHostOrganization.mockResolvedValue({ orgSlug: null, hostOrganization: null });
      await createOrganizerEventScenario({ organizationId: 2 });

      const createdBooking = await handleNewBooking({ bookingData: getBookingData() });

      expect(createdBooking.uid).toBeTruthy();
      expect(await prismock.booking.findMany({ where: { uid: createdBooking.uid } })).toHaveLength(1);
    },
    timeout
  );

  async function bookAcmeDynamicGroup(
    bookingMeta: Omit<Parameters<ReturnType<typeof getNewBookingHandler>>[0], "bookingData">
  ) {
    const handleNewBooking = getNewBookingHandler();
    const org = await createOrganization({ name: "Acme", slug: "acme" });
    mockResolveBookingHostOrganization.mockResolvedValue({
      orgSlug: org.slug,
      hostOrganization: { ...hostOrganization, id: org.id, slug: org.slug },
    });
    const whereClauseSpy = vi.spyOn(UserRepository.prototype, "_getWhereClauseForFindingUsersByUsername");

    const groupUsers = [201, 202].map((id) =>
      getOrganizer({
        name: `group-user-${id}`,
        username: `group-user-${id}`,
        email: `group-user-${id}@example.com`,
        id,
        organizationId: org.id,
        schedules: [TestData.schedules.IstWorkHours],
      })
    );
    await createBookingScenario(getScenarioData({ eventTypes: [], users: groupUsers }, { id: org.id }));

    const booker = getBooker({ email: "booker@example.com", name: "Booker" });
    const createdBooking = await handleNewBooking({
      bookingData: getMockRequestDataForDynamicGroupBooking({
        data: {
          start: `${getDate({ dateIncrement: 1 }).dateString}T05:00:00.000Z`,
          end: `${getDate({ dateIncrement: 1 }).dateString}T05:30:00.000Z`,
          eventTypeId: 0,
          eventTypeSlug: "group-user-201+group-user-202",
          user: "group-user-201+group-user-202",
          responses: {
            email: booker.email,
            name: booker.name,
            location: { optionValue: "", value: "New York" },
          },
        },
      }),
      ...bookingMeta,
    });

    return { createdBooking, whereClauseSpy };
  }

  test(
    "looks up dynamic group users in the organization resolved from the host",
    async () => {
      const { createdBooking, whereClauseSpy } = await bookAcmeDynamicGroup({ hostname: "acme.example.com" });

      expect(createdBooking.uid).toBeTruthy();
      expect(mockResolveBookingHostOrganization).toHaveBeenCalledWith({
        hostname: "acme.example.com",
        forcedSlug: undefined,
        isPlatform: false,
      });
      expect(whereClauseSpy).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: "acme" }));
    },
    timeout
  );

  test(
    "looks up dynamic group users in the forced organization when the host check is skipped (API v2)",
    async () => {
      const { createdBooking, whereClauseSpy } = await bookAcmeDynamicGroup({
        hostname: "localhost:5555",
        forcedSlug: "acme",
        skipHostOrganizationCheck: true,
      });

      expect(createdBooking.uid).toBeTruthy();
      expect(mockResolveBookingHostOrganization).toHaveBeenCalledWith({
        hostname: "",
        forcedSlug: "acme",
        isPlatform: false,
      });
      expect(whereClauseSpy).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: "acme" }));
    },
    timeout
  );

  test(
    "keeps resolving dynamic group users from the host when the host check is skipped without a forced organization",
    async () => {
      const { createdBooking } = await bookAcmeDynamicGroup({
        hostname: "localhost:5555",
        skipHostOrganizationCheck: true,
      });

      expect(createdBooking.uid).toBeTruthy();
      expect(mockResolveBookingHostOrganization).toHaveBeenCalledWith({
        hostname: "localhost:5555",
        forcedSlug: undefined,
        isPlatform: false,
      });
    },
    timeout
  );
});
