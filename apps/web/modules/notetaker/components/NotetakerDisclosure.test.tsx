import type { NotetakerDisclosureDto } from "@calcom/lib/dto/NotetakerStateDto";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getSelectedLocationType, NotetakerDisclosure } from "./NotetakerDisclosure";

// The shared setup's `t` drops interpolation values; this makes the host observable.
vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

// The shared setup's mock of this module has no APP_NAME, so its keys are repeated here.
vi.mock("@calcom/lib/constants", () => ({
  APP_NAME: "Test App",
  DEFAULT_LIGHT_BRAND_COLOR: "DEFAULT_LIGHT_BRAND_COLOR",
  DEFAULT_DARK_BRAND_COLOR: "DEFAULT_DARK_BRAND_COLOR",
  BOOKER_NUMBER_OF_DAYS_TO_LOAD: 1,
}));

type DisclosureQueryInput = { eventTypeId: number };
type DisclosureQueryOptions = { enabled: boolean; retry: boolean; staleTime: number };

const mocks = vi.hoisted(() => ({
  useQuery:
    vi.fn<
      (
        input: DisclosureQueryInput,
        options: DisclosureQueryOptions
      ) => { data: NotetakerDisclosureDto | undefined }
    >(),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: { viewer: { public: { notetakerDisclosure: { useQuery: mocks.useQuery } } } },
}));

const DISCLOSURE_ID = "notetaker-disclosure";

function buildDisclosure(overrides: Partial<NotetakerDisclosureDto> = {}): NotetakerDisclosureDto {
  return {
    enabledByDefault: true,
    onBehalfOf: "Ada",
    supportedLocationTypes: ["integrations:zoom"],
    ...overrides,
  };
}

function renderDisclosure(
  data: NotetakerDisclosureDto | undefined,
  props: { eventTypeId?: number | null; selectedLocationType?: string | null } = {}
) {
  mocks.useQuery.mockReturnValue({ data });
  const { eventTypeId = 42, selectedLocationType = "integrations:zoom" } = props;
  render(<NotetakerDisclosure eventTypeId={eventTypeId} selectedLocationType={selectedLocationType} />);
}

describe("NotetakerDisclosure", () => {
  it("shows the disclosure on behalf of the host when enabled for the selected location", () => {
    renderDisclosure(buildDisclosure());

    expect(screen.getByTestId(DISCLOSURE_ID)).toHaveTextContent(
      `notetaker_disclosure:${JSON.stringify({ host: "Ada" })}`
    );
  });

  it("falls back to the app name when there is no host to act on behalf of", () => {
    renderDisclosure(buildDisclosure({ onBehalfOf: null }));

    expect(screen.getByTestId(DISCLOSURE_ID)).toHaveTextContent(
      `notetaker_disclosure:${JSON.stringify({ host: "Test App" })}`
    );
  });

  it("uses the colleague wording when the results are shared with colleagues", () => {
    renderDisclosure(buildDisclosure({ sharedWithColleagues: true }));

    expect(screen.getByTestId(DISCLOSURE_ID)).toHaveTextContent(
      `notetaker_disclosure_shared:${JSON.stringify({ host: "Ada" })}`
    );
  });

  it.each([[false], [undefined]])("keeps the plain wording when sharedWithColleagues is %s", (shared) => {
    renderDisclosure(buildDisclosure({ sharedWithColleagues: shared }));

    expect(screen.getByTestId(DISCLOSURE_ID)).toHaveTextContent(
      `notetaker_disclosure:${JSON.stringify({ host: "Ada" })}`
    );
    expect(screen.getByTestId(DISCLOSURE_ID)).not.toHaveTextContent("notetaker_disclosure_shared");
  });

  it("renders nothing when the notetaker is not enabled by default", () => {
    renderDisclosure(buildDisclosure({ enabledByDefault: false }));

    expect(screen.queryByTestId(DISCLOSURE_ID)).toBeNull();
  });

  it("renders nothing when the selected location is not supported", () => {
    renderDisclosure(buildDisclosure(), { selectedLocationType: "integrations:jitsi" });

    expect(screen.queryByTestId(DISCLOSURE_ID)).toBeNull();
  });

  it("renders nothing when no location is selected", () => {
    renderDisclosure(buildDisclosure(), { selectedLocationType: null });

    expect(screen.queryByTestId(DISCLOSURE_ID)).toBeNull();
  });

  it("renders nothing and disables the query when there is no event type id", () => {
    renderDisclosure(undefined, { eventTypeId: null });

    expect(screen.queryByTestId(DISCLOSURE_ID)).toBeNull();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      { eventTypeId: 0 },
      expect.objectContaining({ enabled: false })
    );
  });

  it("enables the query without retries and caches it for five minutes for an event type", () => {
    renderDisclosure(buildDisclosure(), { eventTypeId: 42 });

    expect(mocks.useQuery).toHaveBeenCalledWith(
      { eventTypeId: 42 },
      { enabled: true, retry: false, staleTime: 5 * 60 * 1000 }
    );
  });
});

describe("getSelectedLocationType", () => {
  const twoLocations = [{ type: "integrations:zoom" }, { type: "integrations:jitsi" }];
  const oneLocation = [{ type: "integrations:zoom" }];

  it("returns the booker's chosen value when the response carries one", () => {
    expect(getSelectedLocationType({ value: "x", optionValue: "" }, twoLocations)).toBe("x");
  });

  it("returns the only location's type when the booker has no choice to make", () => {
    expect(getSelectedLocationType(undefined, oneLocation)).toBe("integrations:zoom");
  });

  it("returns null when several locations exist and none was chosen", () => {
    expect(getSelectedLocationType(undefined, twoLocations)).toBeNull();
  });

  it.each([["str"], [null], [{ value: 1 }]])("returns null for the malformed response %j", (response) => {
    expect(getSelectedLocationType(response, twoLocations)).toBeNull();
  });
});
