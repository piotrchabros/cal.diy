import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotetakerMutations } from "./useNotetakerMutations";

type MutationOptions<TData = unknown, TVariables = unknown> = {
  onSuccess?: (data: TData, variables: TVariables) => Promise<void> | void;
  onError?: (error: { message: string }) => void;
};
type MutationStub = { mutate: () => void; isPending: boolean };
type UseMutationMock = ReturnType<typeof createUseMutationMock>;
type HookKey = "setEnabled" | "stop" | "regenerateSummary" | "setSharing" | "exportResults" | "deleteResults";
type DownloadFile = { filename: string; mimeType: string; content: string };

function createUseMutationMock() {
  return vi.fn<(options: MutationOptions) => MutationStub>();
}

const mocks = vi.hoisted(() => {
  const createUseMutation = () => vi.fn<(options: MutationOptions) => MutationStub>();
  return {
    showToast: vi.fn<(message: string, variant: string) => void>(),
    downloadTextFile: vi.fn<(file: DownloadFile) => void>(),
    invalidateGetState: vi.fn<() => Promise<void>>(),
    invalidateGetActivity: vi.fn<() => Promise<void>>(),
    invalidateListPassages: vi.fn<() => Promise<void>>(),
    setGetStateData: vi.fn<(input: { bookingUid: string }, data: unknown) => void>(),
    setEnabled: createUseMutation(),
    stop: createUseMutation(),
    regenerateSummary: createUseMutation(),
    setSharing: createUseMutation(),
    exportResults: createUseMutation(),
    deleteResults: createUseMutation(),
  };
});

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("@calcom/web/modules/notetaker/lib/downloadTextFile", () => ({
  downloadTextFile: mocks.downloadTextFile,
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    // A plain function, not vi.fn: the beforeEach below clears every hoisted mock, which must not wipe this implementation.
    useUtils: () => ({
      viewer: {
        notetaker: {
          getState: { invalidate: mocks.invalidateGetState, setData: mocks.setGetStateData },
          getActivity: { invalidate: mocks.invalidateGetActivity },
          listPassages: { invalidate: mocks.invalidateListPassages },
        },
      },
    }),
    viewer: {
      notetaker: {
        setEnabled: { useMutation: mocks.setEnabled },
        stop: { useMutation: mocks.stop },
        regenerateSummary: { useMutation: mocks.regenerateSummary },
        setSharing: { useMutation: mocks.setSharing },
        export: { useMutation: mocks.exportResults },
        deleteResults: { useMutation: mocks.deleteResults },
      },
    },
  },
}));

const HOOK_KEYS: HookKey[] = [
  "setEnabled",
  "stop",
  "regenerateSummary",
  "setSharing",
  "exportResults",
  "deleteResults",
];

const REASONS = [
  "FEATURE_DISABLED",
  "UNSUPPORTED_PLATFORM",
  "CAL_VIDEO",
  "IN_PERSON_OR_PHONE",
  "NO_MEETING_LINK",
  "BOOKING_NOT_ACTIVE",
  "MEETING_ENDED",
  "REJOIN_BLOCKED",
];

const stubs: Record<HookKey, MutationStub> = {
  setEnabled: { mutate: vi.fn(), isPending: false },
  stop: { mutate: vi.fn(), isPending: false },
  regenerateSummary: { mutate: vi.fn(), isPending: false },
  setSharing: { mutate: vi.fn(), isPending: false },
  exportResults: { mutate: vi.fn(), isPending: false },
  deleteResults: { mutate: vi.fn(), isPending: false },
};

function getMutationOptions(useMutation: UseMutationMock): MutationOptions {
  const options = useMutation.mock.calls[0]?.[0];
  if (!options) throw new Error("useMutation was not called with options");
  return options;
}

function renderMutations(): ReturnType<typeof renderHook<ReturnType<typeof useNotetakerMutations>, void>> {
  return renderHook(() => useNotetakerMutations());
}

async function runSuccess(key: HookKey, data: unknown = {}, variables: unknown = {}): Promise<void> {
  renderMutations();
  await getMutationOptions(mocks[key]).onSuccess?.(data, variables);
}

describe("useNotetakerMutations", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of HOOK_KEYS) mocks[key].mockReturnValue(stubs[key]);
    mocks.invalidateGetState.mockResolvedValue(undefined);
    mocks.invalidateGetActivity.mockResolvedValue(undefined);
    mocks.invalidateListPassages.mockResolvedValue(undefined);
  });

  it("returns the six mutations", () => {
    const { result } = renderMutations();

    expect(Object.keys(result.current).sort()).toEqual([...HOOK_KEYS].sort());
    for (const key of HOOK_KEYS) expect(result.current[key]).toBe(stubs[key]);
  });

  it.each([
    "setEnabled",
    "stop",
    "regenerateSummary",
    "setSharing",
  ] as const)("%s invalidates getState on success", async (key) => {
    await runSuccess(key, { sharedWithAttendees: true });

    expect(mocks.invalidateGetState).toHaveBeenCalledTimes(1);
  });

  it.each([
    "regenerateSummary",
    "setSharing",
  ] as const)("%s also invalidates the activity list", async (key) => {
    await runSuccess(key, { sharedWithAttendees: true });

    expect(mocks.invalidateGetActivity).toHaveBeenCalledTimes(1);
  });

  it("stop shows the stop-requested toast", async () => {
    await runSuccess("stop");

    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_stop_requested", "success");
  });

  it.each(["setEnabled", "regenerateSummary"] as const)("%s shows no success toast", async (key) => {
    await runSuccess(key);

    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("setSharing shows the share toast when sharing was turned on", async () => {
    await runSuccess("setSharing", { sharedWithAttendees: true });

    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_share_success", "success");
  });

  it("setSharing shows the stop-sharing toast when it was turned off", async () => {
    await runSuccess("setSharing", { sharedWithAttendees: false });

    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_stop_sharing_success", "success");
  });

  it("export downloads the returned file and refreshes the activity list", async () => {
    const file: DownloadFile = { filename: "meeting.md", mimeType: "text/markdown", content: "# Transcript" };

    await runSuccess("exportResults", file);

    expect(mocks.downloadTextFile).toHaveBeenCalledTimes(1);
    expect(mocks.downloadTextFile).toHaveBeenCalledWith({
      filename: "meeting.md",
      mimeType: "text/markdown",
      content: "# Transcript",
    });
    expect(mocks.invalidateGetActivity).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateGetState).not.toHaveBeenCalled();
  });

  it("deleteResults stores the returned state and refreshes passages and activity", async () => {
    const data = { bookingUid: "booking-uid-1", status: "DELETED" };

    await runSuccess("deleteResults", data, { bookingUid: "booking-uid-1" });

    expect(mocks.setGetStateData).toHaveBeenCalledTimes(1);
    expect(mocks.setGetStateData).toHaveBeenCalledWith({ bookingUid: "booking-uid-1" }, data);
    expect(mocks.setGetStateData.mock.calls[0]?.[1]).toBe(data);
    expect(mocks.invalidateListPassages).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateGetActivity).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateGetState).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_delete_results_success", "success");
  });

  it.each(HOOK_KEYS)("%s shows the localized error toast", (key) => {
    renderMutations();

    getMutationOptions(mocks[key]).onError?.({ message: "boom" });

    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_update_failed", "error");
  });

  it.each(REASONS)("maps the BadRequest reason %s to its notetaker_unavailable_ key", (reason) => {
    renderMutations();

    getMutationOptions(mocks.setEnabled).onError?.({ message: reason });

    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith(`notetaker_unavailable_${reason.toLowerCase()}`, "error");
  });
});
