import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { PrismaClient } from "@calcom/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindById,
  mockFindByIdForOrgAdmin,
  mockFindFallbackById,
  mockFindDefaultByUserId,
  mockFindIsPlatformById,
  mockGetBaseUrl,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindByIdForOrgAdmin: vi.fn(),
  mockFindFallbackById: vi.fn(),
  mockFindDefaultByUserId: vi.fn(),
  mockFindIsPlatformById: vi.fn(),
  mockGetBaseUrl: vi.fn(),
}));

vi.mock("@calcom/features/eventtypes/repositories/eventTypeRepository", () => ({
  EventTypeRepository: class {
    findById = mockFindById;
    findByIdForOrgAdmin = mockFindByIdForOrgAdmin;
  },
}));
vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl: mockGetBaseUrl }),
}));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    findFallbackById = mockFindFallbackById;
    enrichUserWithItsProfile = async ({ user }: { user: Record<string, unknown> }) => ({
      ...user,
      profile: { id: 1 },
    });
  },
}));
vi.mock("@calcom/features/teams/repositories/TeamRepository", () => ({
  TeamRepository: class {
    findIsPlatformById = mockFindIsPlatformById;
  },
}));
vi.mock("@calcom/features/calendars/repositories/DestinationCalendarRepository", () => ({
  DestinationCalendarRepository: class {
    findDefaultByUserId = mockFindDefaultByUserId;
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

const prisma = {} as unknown as PrismaClient;

const load = (overrides?: { isUserOrganizationAdmin?: boolean; currentOrganizationId?: number | null }) =>
  getEventTypeById({
    eventTypeId: 10,
    userId: 5,
    prisma,
    isUserOrganizationAdmin: overrides?.isUserOrganizationAdmin ?? false,
    currentOrganizationId: overrides?.currentOrganizationId ?? null,
  });

describe("getEventTypeById", () => {
  beforeEach(() => {
    mockFindById.mockResolvedValue(rawEventType);
    mockFindByIdForOrgAdmin.mockResolvedValue(rawEventType);
    mockFindIsPlatformById.mockResolvedValue({ isPlatform: true });
    mockFindFallbackById.mockResolvedValue({
      id: 5,
      name: "User 5",
      username: "user5",
      avatarUrl: null,
      email: "user5@example.com",
      locale: "en",
      defaultScheduleId: null,
      isPlatformManaged: false,
      timeZone: "UTC",
    });
    mockFindDefaultByUserId.mockResolvedValue(null);
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

  it("reads the caller's default destination calendar behind the repository", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await load();

    expect(mockFindDefaultByUserId).toHaveBeenCalledWith({ userId: 5 });
  });

  it("throws NOT_FOUND with context when the event type does not exist", async () => {
    mockFindById.mockResolvedValue(null);

    const error = await load().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorWithCode);
    expect((error as ErrorWithCode).code).toBe(ErrorCode.NotFound);
  });

  it("falls back to the caller through the user repository when the event type has no users or team", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    mockFindById.mockResolvedValue({ ...rawEventType, users: [], team: null, teamId: null });

    const result = await load();

    expect(mockFindFallbackById).toHaveBeenCalledWith({ id: 5 });
    expect(result.eventType.id).toBe(10);
  });

  it("throws NOT_FOUND when no fallback user exists", async () => {
    mockFindById.mockResolvedValue({ ...rawEventType, users: [], team: null, teamId: null });
    mockFindFallbackById.mockResolvedValue(null);

    const error = await load().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorWithCode);
    expect((error as ErrorWithCode).code).toBe(ErrorCode.NotFound);
  });

  it("throws NOT_FOUND when neither the caller nor a team owns the event type", async () => {
    mockFindById.mockResolvedValue({
      ...rawEventType,
      users: [{ id: 6, username: "user6" }],
      team: null,
      teamId: null,
    });

    const error = await load().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorWithCode);
    expect((error as ErrorWithCode).code).toBe(ErrorCode.NotFound);
  });

  it("lets a platform organization admin load any event type of their organization", async () => {
    const result = await load({ isUserOrganizationAdmin: true, currentOrganizationId: 1 });

    expect(mockFindIsPlatformById).toHaveBeenCalledWith({ teamId: 1 });
    expect(mockFindByIdForOrgAdmin).toHaveBeenCalledWith({ id: 10, organizationId: 1 });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(result.eventType.id).toBe(10);
  });

  it("falls back to the ownership check when the organization is not a platform one", async () => {
    mockFindIsPlatformById.mockResolvedValue({ isPlatform: false });

    await load({ isUserOrganizationAdmin: true, currentOrganizationId: 1 });

    expect(mockFindByIdForOrgAdmin).not.toHaveBeenCalled();
    expect(mockFindById).toHaveBeenCalledWith({ id: 10, userId: 5 });
  });
});
