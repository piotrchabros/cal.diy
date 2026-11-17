import { SchedulingType } from "@calcom/prisma/enums";
import type { Logger } from "tslog";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./loadUsers", () => ({ loadUsers: vi.fn() }));
vi.mock("@calcom/features/watchlist/operations/filter-blocked-users.controller", () => ({
  filterBlockedUsers: vi.fn(async (users: unknown[]) => ({ eligibleUsers: users, blockedCount: 0 })),
}));
vi.mock("@calcom/features/watchlist/lib/telemetry", () => ({ sentrySpan: undefined }));
vi.mock("@calcom/app-store/delegationCredential", () => ({
  enrichUsersWithDelegationCredentials: vi.fn(async ({ users }: { users: unknown[] }) => users),
}));
vi.mock("@calcom/lib/getOrgIdFromMemberOrTeamId", () => ({ default: vi.fn(async () => null) }));
vi.mock("@calcom/features/profile/repositories/ProfileRepository", () => ({
  ProfileRepository: { findFirstOrganizationIdForUser: vi.fn(async () => null) },
}));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  withSelectedCalendars: vi.fn((user: unknown) => user),
}));
vi.mock("@calcom/prisma", () => ({ default: {}, userSelect: {} }));

import { filterBlockedUsers } from "@calcom/features/watchlist/operations/filter-blocked-users.controller";
import { loadAndValidateUsers } from "./loadAndValidateUsers";
import { loadUsers } from "./loadUsers";

const users = [
  { id: 1, email: "alice@example.com", allowDynamicBooking: true, credentials: [] },
  { id: 2, email: "bob@example.com", allowDynamicBooking: true, credentials: [] },
  { id: 3, email: "carol@example.com", allowDynamicBooking: true, credentials: [] },
];

const baseEventType = {
  id: 100,
  userId: null,
  teamId: 10,
  team: { id: 10, parentId: null },
  parent: null,
  schedulingType: SchedulingType.COLLECTIVE,
  metadata: { allowBookerToSelectHosts: true },
  seatsPerTimeSlot: null,
  hosts: [],
  users: [],
  maxLeadThreshold: null,
  assignAllTeamMembers: false,
  assignRRMembersUsingSegment: false,
  rrSegmentQueryValue: null,
  isRRWeightsEnabled: false,
  rescheduleWithSameRoundRobinHost: false,
  includeNoShowInRRCalculation: false,
  rrHostSubsetEnabled: false,
};

type Props = Parameters<typeof loadAndValidateUsers>[0];

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger<unknown>;

const callLoadAndValidateUsers = (
  overrides: Partial<Props> & { eventType?: Partial<Props["eventType"]> }
) => {
  const { eventType, ...rest } = overrides;
  return loadAndValidateUsers({
    eventTypeId: 100,
    dynamicUserList: [],
    logger,
    routedTeamMemberIds: null,
    contactOwnerEmail: null,
    rescheduleUid: null,
    isPlatform: false,
    hostname: undefined,
    forcedSlug: undefined,
    ...rest,
    eventType: { ...baseEventType, ...eventType } as Props["eventType"],
  });
};

const ids = (list: { id: number }[]) => list.map((user) => user.id);

describe("loadAndValidateUsers booker host selection", () => {
  beforeEach(() => {
    vi.mocked(loadUsers).mockResolvedValue(users as unknown as Awaited<ReturnType<typeof loadUsers>>);
    vi.mocked(filterBlockedUsers).mockClear();
  });

  it("keeps only the requested hosts when enabled", async () => {
    const result = await callLoadAndValidateUsers({ rrHostSubsetIds: [1, 3] });

    expect(ids(result.fixedUsers)).toEqual([1, 3]);
    expect(ids(vi.mocked(filterBlockedUsers).mock.calls[0][0] as { id: number }[])).toEqual([1, 3]);
  });

  it("ignores the subset when the feature is off", async () => {
    const result = await callLoadAndValidateUsers({
      rrHostSubsetIds: [1],
      eventType: { metadata: {} },
    });

    expect(ids(result.fixedUsers)).toEqual([1, 2, 3]);
  });

  it("ignores the subset for non-collective events", async () => {
    const result = await callLoadAndValidateUsers({
      rrHostSubsetIds: [1],
      eventType: { schedulingType: SchedulingType.ROUND_ROBIN },
    });

    expect(ids(result.fixedUsers)).toEqual([1, 2, 3]);
  });

  it("derives the hosts from the original booking on reschedule", async () => {
    const result = await callLoadAndValidateUsers({
      rescheduleUid: "reschedule-uid",
      originalRescheduledBooking: {
        userId: 2,
        attendees: [{ email: "Carol@example.com" }, { email: "guest@example.com" }],
      },
    });

    expect(ids(result.fixedUsers)).toEqual([2, 3]);
  });

  it("prefers the explicit subset over the original booking", async () => {
    const result = await callLoadAndValidateUsers({
      rrHostSubsetIds: [1],
      originalRescheduledBooking: { userId: 2, attendees: [] },
    });

    expect(ids(result.fixedUsers)).toEqual([1]);
  });
});
