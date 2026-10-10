import type { NotetakerEventTypeSharingDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotetakerEventTypeSharing, useNotetakerSharingCandidates } from "./useNotetakerEventTypeSharing";

type MutationOptions = {
  onSuccess?: (data: NotetakerEventTypeSharingDto) => void;
  onError?: (error: { message: string }) => void;
};
type InfiniteOptions = {
  enabled: boolean;
  retry: boolean;
  getNextPageParam: (last: { nextCursor: number | null }) => number | undefined;
};

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<(input: { eventTypeId: number }, options: { retry: boolean }) => object>(),
  useMutation: vi.fn<(options: MutationOptions) => object>(),
  useInfiniteQuery: vi.fn<(input: object, options: InfiniteOptions) => object>(),
  setData: vi.fn<(input: { eventTypeId: number }, data: NotetakerEventTypeSharingDto) => void>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    // A plain function, not vi.fn: the beforeEach below resets every hoisted mock.
    useUtils: () => ({ viewer: { notetaker: { getEventTypeSharing: { setData: mocks.setData } } } }),
    viewer: {
      notetaker: {
        getEventTypeSharing: { useQuery: mocks.useQuery },
        setEventTypeSharing: { useMutation: mocks.useMutation },
        listEventTypeSharingCandidates: { useInfiniteQuery: mocks.useInfiniteQuery },
      },
    },
  },
}));

const dto: NotetakerEventTypeSharingDto = {
  eventTypeId: 7,
  available: true,
  unavailableReason: null,
  mode: "TEAM",
  teamName: "Team",
  people: [],
  setAt: null,
  setByName: null,
};

function getMutationOptions(): MutationOptions {
  const options = mocks.useMutation.mock.calls[0]?.[0];
  if (!options) throw new Error("useMutation was not called with options");
  return options;
}

describe("useNotetakerEventTypeSharing", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.useQuery.mockReturnValue({ data: dto });
    mocks.useMutation.mockReturnValue({ mutate: vi.fn() });
  });

  it("queries the sharing setting without retrying and returns query and save", () => {
    const { result } = renderHook(() => useNotetakerEventTypeSharing(7));

    expect(mocks.useQuery).toHaveBeenCalledWith({ eventTypeId: 7 }, { retry: false });
    expect(result.current.query).toEqual({ data: dto });
    expect(result.current.save).toHaveProperty("mutate");
  });

  it("caches the returned setting and toasts on success", () => {
    renderHook(() => useNotetakerEventTypeSharing(7));

    getMutationOptions().onSuccess?.(dto);

    expect(mocks.setData).toHaveBeenCalledWith({ eventTypeId: 7 }, dto);
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_sharing_saved", "success");
  });

  it.each([
    ["NOT_A_TEAM_EVENT_TYPE", "notetaker_sharing_error_not_a_team_event_type"],
    ["PERSON_NOT_ELIGIBLE", "notetaker_sharing_error_person_not_eligible"],
    ["TOO_MANY_PEOPLE", "notetaker_sharing_error_too_many_people"],
    ["FEATURE_DISABLED", "notetaker_unavailable_feature_disabled"],
    ["boom", "notetaker_sharing_save_failed"],
  ])("maps the %s error to the %s toast", (message, key) => {
    renderHook(() => useNotetakerEventTypeSharing(7));

    getMutationOptions().onError?.({ message });

    expect(mocks.showToast).toHaveBeenCalledWith(key, "error");
  });
});

describe("useNotetakerSharingCandidates", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.useInfiniteQuery.mockReturnValue({ data: undefined });
  });

  it("passes the search, a page size and the enabled flag", () => {
    renderHook(() => useNotetakerSharingCandidates({ eventTypeId: 7, search: " ann ", enabled: true }));

    const [input, options] = mocks.useInfiniteQuery.mock.calls[0] ?? [];
    expect(input).toEqual({ eventTypeId: 7, search: "ann", limit: 20 });
    expect(options?.enabled).toBe(true);
    expect(options?.retry).toBe(false);
    expect(options?.getNextPageParam({ nextCursor: 5 })).toBe(5);
    expect(options?.getNextPageParam({ nextCursor: null })).toBeUndefined();
  });

  it("omits an empty search", () => {
    renderHook(() => useNotetakerSharingCandidates({ eventTypeId: 7, search: "", enabled: false }));

    const [input, options] = mocks.useInfiniteQuery.mock.calls[0] ?? [];
    expect(input).toEqual({ eventTypeId: 7, search: undefined, limit: 20 });
    expect(options?.enabled).toBe(false);
  });
});
