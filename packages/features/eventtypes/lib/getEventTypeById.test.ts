import type { PrismaClient } from "@calcom/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindById, mockGetBaseUrl } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockGetBaseUrl: vi.fn(),
}));

vi.mock("@calcom/features/eventtypes/repositories/eventTypeRepository", () => ({
  EventTypeRepository: class {
    findById = mockFindById;
  },
}));
vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl: mockGetBaseUrl }),
}));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    enrichUserWithItsProfile = async ({ user }: { user: Record<string, unknown> }) => ({
      ...user,
      profile: { id: 1 },
    });
  },
}));
vi.mock("@calcom/features/bookings/lib/getBookingFields", () => ({
  getBookingFieldsWithSystemFields: () => [],
}));
vi.mock("@calcom/app-store/server", () => ({ getLocationGroupedOptions: async () => [] }));
vi.mock("@calcom/app-store/utils", () => ({ getEventTypeAppData: () => undefined }));
vi.mock("@calcom/app-store/zod-utils", () => ({
  eventTypeMetaDataSchemaWithTypedApps: { parse: (value: unknown) => value },
}));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: async () => (key: string) => key }));

import { getEventTypeById } from "./getEventTypeById";

const member = (id: number, accepted: boolean) => ({
  role: "MEMBER",
  accepted,
  user: {
    id,
    name: `User ${id}`,
    username: `user${id}`,
    email: `user${id}@example.com`,
    avatarUrl: null,
    eventTypes: [],
  },
});

const rawEventType = {
  id: 10,
  teamId: 2,
  owner: null,
  locations: [],
  metadata: {},
  customInputs: [],
  children: [],
  users: [],
  schedule: null,
  restrictionScheduleId: null,
  restrictionSchedule: null,
  instantMeetingSchedule: null,
  schedulingType: "COLLECTIVE",
  periodStartDate: null,
  periodEndDate: null,
  destinationCalendar: null,
  team: {
    id: 2,
    name: "Sales",
    slug: "sales",
    parentId: 1,
    parent: { slug: "bluebee", organizationSettings: null },
    members: [member(5, true), member(6, false)],
  },
};

const prisma = {
  destinationCalendar: { findFirst: async () => null },
} as unknown as PrismaClient;

const load = () =>
  getEventTypeById({
    eventTypeId: 10,
    userId: 5,
    prisma,
    isUserOrganizationAdmin: false,
    currentOrganizationId: null,
  });

describe("getEventTypeById", () => {
  beforeEach(() => {
    mockFindById.mockResolvedValue(rawEventType);
    mockGetBaseUrl.mockImplementation(async ({ organizationId }: { organizationId: number | null }) =>
      organizationId ? "https://bluebee.example.com" : "https://app.example.com"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("keeps the organization parent of the team when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    const result = await load();

    expect(result.team).toMatchObject({ parentId: 1, parent: { slug: "bluebee" } });
    expect(result.eventType.bookerUrl).toBe("https://bluebee.example.com");
    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: 1 });
    expect(result.teamMembers.map((m) => m.id)).toEqual([5, 6]);
  });

  it("treats the team as top-level when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    const result = await load();

    expect(result.team).toMatchObject({ parentId: null, parent: null });
    expect(result.eventType.bookerUrl).toBe("https://app.example.com");
    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: null });
    expect(result.teamMembers.map((m) => m.id)).toEqual([5]);
  });
});
