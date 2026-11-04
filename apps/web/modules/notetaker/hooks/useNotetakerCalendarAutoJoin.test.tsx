import type { NotetakerCalendarAutoJoinSettingsDto } from "@calcom/lib/dto/NotetakerCalendarAutoJoinDto";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotetakerCalendarAutoJoinChange } from "./useNotetakerCalendarAutoJoin";
import { useNotetakerCalendarAutoJoin } from "./useNotetakerCalendarAutoJoin";

type Context = { previous: NotetakerCalendarAutoJoinSettingsDto | undefined };
type MutationOptions = {
  onMutate?: (change: NotetakerCalendarAutoJoinChange) => Promise<Context>;
  onError?: (error: Error, change: NotetakerCalendarAutoJoinChange, context: Context | undefined) => void;
  onSettled?: () => void;
};

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<(input: undefined, options: object) => object>(),
  useMutation: vi.fn<(options: MutationOptions) => object>(),
  cancel: vi.fn<() => Promise<void>>(),
  getData: vi.fn<() => NotetakerCalendarAutoJoinSettingsDto | undefined>(),
  setData: vi.fn<(input: undefined, data: NotetakerCalendarAutoJoinSettingsDto) => void>(),
  invalidate: vi.fn<() => Promise<void>>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    // A plain function, not vi.fn: the beforeEach below resets every hoisted mock.
    useUtils: () => ({
      viewer: {
        notetaker: {
          listCalendarAutoJoin: {
            cancel: mocks.cancel,
            getData: mocks.getData,
            setData: mocks.setData,
            invalidate: mocks.invalidate,
          },
        },
      },
    }),
    viewer: {
      notetaker: {
        listCalendarAutoJoin: { useQuery: mocks.useQuery },
        setCalendarAutoJoin: { useMutation: mocks.useMutation },
      },
    },
  },
}));

const dto: NotetakerCalendarAutoJoinSettingsDto = {
  available: true,
  teamOptions: [{ teamId: 3, name: "Sales" }],
  calendars: [
    {
      selectedCalendarId: "sc-1",
      integration: "google_calendar",
      externalId: "a@b.c",
      enabled: false,
      sharingTeamId: null,
      supported: true,
      lastPollFailed: false,
    },
    {
      selectedCalendarId: "sc-2",
      integration: "office365_calendar",
      externalId: "x@y.z",
      enabled: true,
      sharingTeamId: 3,
      supported: true,
      lastPollFailed: false,
    },
  ],
};

function getMutationOptions(): MutationOptions {
  const options = mocks.useMutation.mock.calls[0]?.[0];
  if (!options) throw new Error("useMutation was not called with options");
  return options;
}

describe("useNotetakerCalendarAutoJoin", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.useQuery.mockReturnValue({ data: dto });
    mocks.useMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.cancel.mockResolvedValue(undefined);
    mocks.invalidate.mockResolvedValue(undefined);
  });

  it("queries the settings without retrying", () => {
    renderHook(() => useNotetakerCalendarAutoJoin());

    expect(mocks.useQuery).toHaveBeenCalledWith(undefined, { retry: false, refetchOnWindowFocus: false });
  });

  it("finds a calendar by integration and external id", () => {
    const { result } = renderHook(() => useNotetakerCalendarAutoJoin());

    expect(result.current.findCalendar("office365_calendar", "x@y.z")?.selectedCalendarId).toBe("sc-2");
    expect(result.current.findCalendar("google_calendar", "x@y.z")).toBeNull();
  });

  it("finds a calendar by selected calendar id", () => {
    const { result } = renderHook(() => useNotetakerCalendarAutoJoin());

    expect(result.current.findCalendarById("sc-1")?.externalId).toBe("a@b.c");
    expect(result.current.findCalendarById("missing")).toBeNull();
  });

  it("finds nothing while the settings load", () => {
    mocks.useQuery.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useNotetakerCalendarAutoJoin());

    expect(result.current.findCalendar("google_calendar", "a@b.c")).toBeNull();
    expect(result.current.findCalendarById("sc-1")).toBeNull();
  });

  it("applies the change optimistically to the cached settings", async () => {
    mocks.getData.mockReturnValue(dto);
    renderHook(() => useNotetakerCalendarAutoJoin());

    const context = await getMutationOptions().onMutate?.({
      selectedCalendarId: "sc-1",
      enabled: true,
      sharingTeamId: 3,
    });

    expect(mocks.cancel).toHaveBeenCalled();
    expect(context).toEqual({ previous: dto });
    const updated = mocks.setData.mock.calls[0]?.[1];
    expect(updated?.calendars[0]).toMatchObject({
      selectedCalendarId: "sc-1",
      enabled: true,
      sharingTeamId: 3,
    });
    expect(updated?.calendars[1]).toEqual(dto.calendars[1]);
  });

  it("skips the optimistic update when nothing is cached", async () => {
    mocks.getData.mockReturnValue(undefined);
    renderHook(() => useNotetakerCalendarAutoJoin());

    await getMutationOptions().onMutate?.({ selectedCalendarId: "sc-1", enabled: true, sharingTeamId: null });

    expect(mocks.setData).not.toHaveBeenCalled();
  });

  it("restores the previous settings and toasts on error", () => {
    renderHook(() => useNotetakerCalendarAutoJoin());

    getMutationOptions().onError?.(
      new Error("boom"),
      { selectedCalendarId: "sc-1", enabled: true, sharingTeamId: null },
      { previous: dto }
    );

    expect(mocks.setData).toHaveBeenCalledWith(undefined, dto);
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_calendar_auto_join_save_failed", "error");
  });

  it("refetches the settings once the save settles", () => {
    renderHook(() => useNotetakerCalendarAutoJoin());

    getMutationOptions().onSettled?.();

    expect(mocks.invalidate).toHaveBeenCalled();
  });
});
