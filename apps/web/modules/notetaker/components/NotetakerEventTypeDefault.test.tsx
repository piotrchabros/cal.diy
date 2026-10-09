import type { NotetakerEventTypeDefaultDto } from "@calcom/lib/dto/NotetakerStateDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerEventTypeDefault } from "./NotetakerEventTypeDefault";

type DefaultQuery = { data: NotetakerEventTypeDefaultDto | undefined; isPending: boolean; isError: boolean };
type MutationInput = { eventTypeId: number; enabledByDefault: boolean };
type MutationOptions = {
  onSuccess?: (data: NotetakerEventTypeDefaultDto) => void;
  onError?: (error: { message: string }) => void;
};
type MutationState = { isPending: boolean };

const EVENT_TYPE_ID = 42;
const TOGGLE_ID = "notetaker-event-type-default";
const BASE_DESCRIPTION = "notetaker_event_type_default_description";
const UNSUPPORTED_PLATFORM_KEY = "notetaker_event_type_unavailable_unsupported_platform";
const CAL_VIDEO_KEY = "notetaker_event_type_unavailable_cal_video";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<(input: { eventTypeId: number }, options: { retry: boolean }) => DefaultQuery>(),
  useMutation:
    vi.fn<(options: MutationOptions) => { mutate: (input: MutationInput) => void; isPending: boolean }>(),
  mutate: vi.fn<(input: MutationInput) => void>(),
  setData: vi.fn<(input: { eventTypeId: number }, data: NotetakerEventTypeDefaultDto) => void>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    // A plain function, not vi.fn: the beforeEach below resets every hoisted mock, which would wipe a vi.fn implementation.
    useUtils: () => ({ viewer: { notetaker: { getEventTypeDefault: { setData: mocks.setData } } } }),
    viewer: {
      notetaker: {
        getEventTypeDefault: { useQuery: mocks.useQuery },
        setEventTypeDefault: { useMutation: mocks.useMutation },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("@formkit/auto-animate/react", () => ({ useAutoAnimate: () => [null] }));

function buildDefault(overrides: Partial<NotetakerEventTypeDefaultDto> = {}): NotetakerEventTypeDefaultDto {
  return { enabledByDefault: false, available: true, unavailableReason: null, ...overrides };
}

function buildQuery(overrides: Partial<DefaultQuery> = {}): DefaultQuery {
  return { data: buildDefault(), isPending: false, isError: false, ...overrides };
}

function renderToggle(
  query: DefaultQuery,
  mutation: MutationState = { isPending: false }
): ReturnType<typeof render> {
  mocks.useQuery.mockReturnValue(query);
  mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: mutation.isPending });
  return render(<NotetakerEventTypeDefault eventTypeId={EVENT_TYPE_ID} />);
}

function getMutationOptions(): MutationOptions {
  const options = mocks.useMutation.mock.calls[0]?.[0];
  if (!options) throw new Error("useMutation was not called with options");
  return options;
}

function getDescription(): string {
  return screen.getByTestId(`${TOGGLE_ID}-description`).textContent ?? "";
}

describe("NotetakerEventTypeDefault", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("renders an enabled, unchecked switch with the base description when available and off", () => {
    renderToggle(buildQuery());

    const toggle = screen.getByTestId(TOGGLE_ID);
    expect(toggle).toHaveAttribute("role", "switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeEnabled();
    expect(screen.getByTestId(`${TOGGLE_ID}-title`).textContent).toBe("notetaker_event_type_default_title");
    expect(getDescription()).toBe(BASE_DESCRIPTION);
    expect(getDescription()).not.toContain("notetaker_event_type_unavailable_");
  });

  it("queries the default for the event type without retrying", () => {
    renderToggle(buildQuery());

    expect(mocks.useQuery).toHaveBeenCalledWith({ eventTypeId: EVENT_TYPE_ID }, { retry: false });
  });

  it("turns the default on when clicked while off", () => {
    renderToggle(buildQuery());

    fireEvent.click(screen.getByTestId(TOGGLE_ID));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({ eventTypeId: EVENT_TYPE_ID, enabledByDefault: true });
  });

  it("shows the switch checked and turns the default off when clicked while on", () => {
    renderToggle(buildQuery({ data: buildDefault({ enabledByDefault: true }) }));

    const toggle = screen.getByTestId(TOGGLE_ID);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();

    fireEvent.click(toggle);

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({ eventTypeId: EVENT_TYPE_ID, enabledByDefault: false });
  });

  it("disables the switch and explains an unsupported platform", () => {
    renderToggle(
      buildQuery({ data: buildDefault({ available: false, unavailableReason: "UNSUPPORTED_PLATFORM" }) })
    );

    const toggle = screen.getByTestId(TOGGLE_ID);
    expect(toggle).toBeDisabled();
    expect(getDescription()).toBe(`${BASE_DESCRIPTION} ${UNSUPPORTED_PLATFORM_KEY}`);

    fireEvent.click(toggle);

    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("disables the switch and explains Cal Video", () => {
    renderToggle(buildQuery({ data: buildDefault({ available: false, unavailableReason: "CAL_VIDEO" }) }));

    expect(screen.getByTestId(TOGGLE_ID)).toBeDisabled();
    expect(getDescription()).toBe(`${BASE_DESCRIPTION} ${CAL_VIDEO_KEY}`);
    expect(getDescription()).not.toContain(UNSUPPORTED_PLATFORM_KEY);
  });

  it("keeps showing an enabled default as checked while unavailable", () => {
    renderToggle(
      buildQuery({
        data: buildDefault({
          enabledByDefault: true,
          available: false,
          unavailableReason: "UNSUPPORTED_PLATFORM",
        }),
      })
    );

    const toggle = screen.getByTestId(TOGGLE_ID);
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("renders nothing when the feature is disabled", () => {
    renderToggle(
      buildQuery({ data: buildDefault({ available: false, unavailableReason: "FEATURE_DISABLED" }) })
    );

    expect(screen.queryByTestId(TOGGLE_ID)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${TOGGLE_ID}-title`)).not.toBeInTheDocument();
  });

  it("renders nothing while the default is loading", () => {
    renderToggle(buildQuery({ data: undefined, isPending: true }));

    expect(screen.queryByTestId(TOGGLE_ID)).not.toBeInTheDocument();
  });

  it("renders nothing when the query fails", () => {
    renderToggle(buildQuery({ data: undefined, isError: true }));

    expect(screen.queryByTestId(TOGGLE_ID)).not.toBeInTheDocument();
  });

  it("disables the switch while the mutation is pending", () => {
    renderToggle(buildQuery(), { isPending: true });

    expect(screen.getByTestId(TOGGLE_ID)).toBeDisabled();
  });

  it("caches the returned default on success without a toast", () => {
    renderToggle(buildQuery());
    const dto = buildDefault({ enabledByDefault: true });

    getMutationOptions().onSuccess?.(dto);

    expect(mocks.setData).toHaveBeenCalledTimes(1);
    expect(mocks.setData).toHaveBeenCalledWith({ eventTypeId: EVENT_TYPE_ID }, dto);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it.each([
    ["UNSUPPORTED_PLATFORM", UNSUPPORTED_PLATFORM_KEY],
    ["CAL_VIDEO", CAL_VIDEO_KEY],
    ["FEATURE_DISABLED", "notetaker_unavailable_feature_disabled"],
    ["MEETING_ENDED", "notetaker_update_failed"],
    ["boom", "notetaker_update_failed"],
  ])("maps the %s error to the %s toast", (message, key) => {
    renderToggle(buildQuery());

    getMutationOptions().onError?.({ message });

    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith(key, "error");
  });

  it("disables the switch with only the base description when unavailable without a reason", () => {
    renderToggle(buildQuery({ data: buildDefault({ available: false, unavailableReason: null }) }));

    expect(screen.getByTestId(TOGGLE_ID)).toBeDisabled();
    expect(getDescription()).toBe(BASE_DESCRIPTION);
  });
});
