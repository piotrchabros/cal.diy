import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdHocLinkCopyKeys, getAdHocLinkCopyVariant, useNotetakerAdHoc } from "./useNotetakerAdHoc";

type MutationOptions = {
  onSuccess?: (data: { bookingUid: string; reused: boolean }) => Promise<void> | void;
  onError?: (error: { message: string; data?: { code?: string } | null }) => void;
};

const mocks = vi.hoisted(() => ({
  showToast: vi.fn<(message: string, variant: string) => void>(),
  invalidateBookings: vi.fn<() => Promise<void>>(),
  useQuery:
    vi.fn<
      (
        input: undefined,
        options: { enabled: boolean }
      ) => { data: { enabledPlatforms: NotetakerPlatformDto[] } | undefined }
    >(),
  useMutation: vi.fn<(options: MutationOptions) => { mutateAsync: () => Promise<unknown> }>(),
  mutateAsync: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({ viewer: { bookings: { invalidate: mocks.invalidateBookings } } }),
    viewer: {
      notetaker: {
        getAdHocOptions: { useQuery: mocks.useQuery },
        dispatchToMeeting: { useMutation: mocks.useMutation },
      },
    },
  },
}));

const INPUT = {
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  sharingTeamId: null,
  acknowledgedNotice: true,
} as const;

function setup() {
  const view = renderHook(() => useNotetakerAdHoc({ enabled: true }));
  const options = mocks.useMutation.mock.calls[0]?.[0] as MutationOptions;
  return { ...view, options };
}

describe("useNotetakerAdHoc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invalidateBookings.mockResolvedValue(undefined);
    mocks.useQuery.mockReturnValue({ data: undefined });
    mocks.useMutation.mockReturnValue({ mutateAsync: mocks.mutateAsync });
  });

  it("passes the enabled flag to the options query", () => {
    renderHook(() => useNotetakerAdHoc({ enabled: false }));

    expect(mocks.useQuery).toHaveBeenCalledWith(undefined, { enabled: false });
  });

  it.each([
    ["FEATURE_DISABLED", "notetaker_ad_hoc_feature_disabled"],
    ["PROVIDER_UNAVAILABLE", "notetaker_ad_hoc_provider_unavailable"],
    ["INVALID_MEETING_LINK", "notetaker_ad_hoc_invalid_link"],
    ["UNSUPPORTED_PLATFORM", "notetaker_ad_hoc_unsupported_platform"],
    ["WRAPPED_MEETING_LINK", "notetaker_ad_hoc_wrapped_link"],
    ["AD_HOC_LIMIT_REACHED", "notetaker_ad_hoc_limit_reached"],
    ["TEAM_NOT_ALLOWED", "notetaker_ad_hoc_team_not_allowed"],
    ["INVALID_DURATION", "notetaker_ad_hoc_invalid_duration"],
  ])("maps %s to %s", (code, key) => {
    const { options } = setup();
    options.onError?.({ message: code });

    expect(mocks.showToast).toHaveBeenCalledWith(key, "error");
  });

  it.each([
    [["MICROSOFT_TEAMS"], "INVALID_MEETING_LINK", "notetaker_ad_hoc_invalid_link_teams"],
    [["MICROSOFT_TEAMS"], "UNSUPPORTED_PLATFORM", "notetaker_ad_hoc_unsupported_platform_teams"],
    [["GOOGLE_MEET", "MICROSOFT_TEAMS"], "INVALID_MEETING_LINK", "notetaker_ad_hoc_invalid_link_any"],
    [["GOOGLE_MEET", "MICROSOFT_TEAMS"], "UNSUPPORTED_PLATFORM", "notetaker_ad_hoc_unsupported_platform_any"],
    [["GOOGLE_MEET"], "INVALID_MEETING_LINK", "notetaker_ad_hoc_invalid_link"],
    [["GOOGLE_MEET", "MICROSOFT_TEAMS"], "WRAPPED_MEETING_LINK", "notetaker_ad_hoc_wrapped_link"],
  ] as const)("with %j enabled maps %s to %s", (enabledPlatforms, code, key) => {
    mocks.useQuery.mockReturnValue({ data: { enabledPlatforms: [...enabledPlatforms] } });
    const { options } = setup();
    options.onError?.({ message: code });

    expect(mocks.showToast).toHaveBeenCalledWith(key, "error");
  });

  it("maps a rate limit to its own message", () => {
    const { options } = setup();
    options.onError?.({ message: "Too many", data: { code: "TOO_MANY_REQUESTS" } });

    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_ad_hoc_rate_limited", "error");
  });

  it("falls back to a generic message for unknown errors such as validation failures", () => {
    const { options } = setup();
    options.onError?.({ message: '[{"code":"too_big"}]', data: { code: "BAD_REQUEST" } });

    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_ad_hoc_failed", "error");
  });

  it("invalidates bookings and shows the dispatched toast", async () => {
    const { options } = setup();
    await options.onSuccess?.({ bookingUid: "uid-1", reused: false });

    expect(mocks.invalidateBookings).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_ad_hoc_dispatched", "success");
  });

  it("shows the reused toast when the notetaker was already set up", async () => {
    const { options } = setup();
    await options.onSuccess?.({ bookingUid: "uid-1", reused: true });

    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_ad_hoc_reused", "success");
  });

  it("resolves dispatch to the booking uid", async () => {
    mocks.mutateAsync.mockResolvedValue({ bookingUid: "uid-1", reused: false });
    const { result } = setup();

    await expect(result.current.dispatch(INPUT)).resolves.toBe("uid-1");
    expect(mocks.mutateAsync).toHaveBeenCalledWith(INPUT);
  });

  it("resolves dispatch to null when the mutation fails", async () => {
    mocks.mutateAsync.mockRejectedValue(new Error("FEATURE_DISABLED"));
    const { result } = setup();

    await expect(result.current.dispatch(INPUT)).resolves.toBeNull();
  });
});

describe("getAdHocLinkCopyVariant", () => {
  it.each([
    [undefined, "meet"],
    [[], "meet"],
    [["GOOGLE_MEET"], "meet"],
    [["MICROSOFT_TEAMS"], "teams"],
    [["GOOGLE_MEET", "MICROSOFT_TEAMS"], "any"],
    [["MICROSOFT_TEAMS", "GOOGLE_MEET"], "any"],
  ] as const)("picks the copy for %j", (enabledPlatforms, variant) => {
    expect(getAdHocLinkCopyVariant(enabledPlatforms)).toBe(variant);
  });
});

describe("getAdHocLinkCopyKeys", () => {
  it("keeps the unsuffixed keys for Meet", () => {
    expect(getAdHocLinkCopyKeys("meet")).toEqual({
      label: "notetaker_meeting_link_label",
      description: "notetaker_add_to_meeting_description",
      invalid: "notetaker_ad_hoc_invalid_link",
      unsupported: "notetaker_ad_hoc_unsupported_platform",
      placeholder: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("uses the Teams keys and a Teams placeholder", () => {
    expect(getAdHocLinkCopyKeys("teams")).toEqual({
      label: "notetaker_meeting_link_label_teams",
      description: "notetaker_add_to_meeting_description_teams",
      invalid: "notetaker_ad_hoc_invalid_link_teams",
      unsupported: "notetaker_ad_hoc_unsupported_platform_teams",
      placeholder: "https://teams.microsoft.com/meet/123456789012?p=AbCdEf",
    });
  });

  it("uses the combined keys with the Meet placeholder", () => {
    expect(getAdHocLinkCopyKeys("any")).toEqual({
      label: "notetaker_meeting_link_label_any",
      description: "notetaker_add_to_meeting_description_any",
      invalid: "notetaker_ad_hoc_invalid_link_any",
      unsupported: "notetaker_ad_hoc_unsupported_platform_any",
      placeholder: "https://meet.google.com/abc-defg-hij",
    });
  });
});
