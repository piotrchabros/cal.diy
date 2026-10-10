import type {
  NotetakerEventTypeSharingDto,
  NotetakerSharingCandidateDto,
  NotetakerSharingPersonDto,
} from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerEventTypeSharing } from "./NotetakerEventTypeSharing";

type SharingQuery = { data: NotetakerEventTypeSharingDto | undefined; isPending: boolean; isError: boolean };
type SaveInput = { eventTypeId: number; mode: string; userIds?: number[] };
type CandidatesParams = { eventTypeId: number; search: string; enabled: boolean };

const EVENT_TYPE_ID = 42;

const mocks = vi.hoisted(() => ({
  useSharing: vi.fn<(eventTypeId: number) => { query: SharingQuery; save: object }>(),
  useCandidates: vi.fn<(params: CandidatesParams) => object>(),
  mutate: vi.fn<(input: SaveInput, options?: object) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars
        ? `${key}:${Object.values(vars)
            .map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value)))
            .join("|")}`
        : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../hooks/useNotetakerEventTypeSharing", () => ({
  useNotetakerEventTypeSharing: mocks.useSharing,
  useNotetakerSharingCandidates: mocks.useCandidates,
}));

function person(
  userId: number,
  overrides: Partial<NotetakerSharingPersonDto> = {}
): NotetakerSharingPersonDto {
  return {
    userId,
    name: `Person ${userId}`,
    email: `p${userId}@example.com`,
    avatarUrl: null,
    stillEligible: true,
    ...overrides,
  };
}

function buildDto(overrides: Partial<NotetakerEventTypeSharingDto> = {}): NotetakerEventTypeSharingDto {
  return {
    eventTypeId: EVENT_TYPE_ID,
    available: true,
    unavailableReason: null,
    mode: "HOSTS_ONLY",
    teamName: "Sales",
    people: [],
    setAt: null,
    setByName: null,
    ...overrides,
  };
}

function setup(
  dto: NotetakerEventTypeSharingDto | undefined = buildDto(),
  state: Partial<SharingQuery> = {},
  candidates: NotetakerSharingCandidateDto[] = []
): ReturnType<typeof render> {
  mocks.useSharing.mockReturnValue({
    query: { data: dto, isPending: false, isError: false, ...state },
    save: { mutate: mocks.mutate, isPending: false },
  });
  mocks.useCandidates.mockReturnValue({
    data: { pages: [{ items: candidates, nextCursor: null }] },
    isFetching: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  });
  return render(<NotetakerEventTypeSharing eventTypeId={EVENT_TYPE_ID} />);
}

const container = () => screen.queryByTestId("notetaker-event-type-sharing");
const modeRadio = (m: string) => screen.getByTestId(`notetaker-sharing-mode-${m}`);
const saveButton = () => screen.getByTestId("notetaker-sharing-save");

describe("NotetakerEventTypeSharing", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it.each([
    ["pending", undefined, { isPending: true }],
    ["error", undefined, { isError: true }],
    ["unavailable", buildDto({ available: false, unavailableReason: "NOT_A_TEAM_EVENT_TYPE" }), {}],
  ])("renders nothing when %s", (_name, dto, state) => {
    setup(dto, state);

    expect(container()).not.toBeInTheDocument();
  });

  it("shows the title, the from-now-on sentence and the three modes", () => {
    setup();

    expect(screen.getByText("notetaker_sharing_title")).toBeInTheDocument();
    expect(screen.getByText("notetaker_sharing_description")).toBeInTheDocument();
    expect(modeRadio("hosts_only")).toBeChecked();
    expect(modeRadio("team")).not.toBeChecked();
    expect(modeRadio("selected_people")).not.toBeChecked();
  });

  it("shows the picker only while selected people is chosen and keeps its state across a mode switch", () => {
    setup(buildDto({ mode: "SELECTED_PEOPLE", people: [person(1)] }));
    expect(screen.getByTestId("notetaker-sharing-people")).toBeInTheDocument();

    fireEvent.click(modeRadio("team"));
    expect(screen.queryByTestId("notetaker-sharing-people")).not.toBeInTheDocument();

    fireEvent.click(modeRadio("selected_people"));
    expect(screen.getByTestId("notetaker-sharing-people")).toBeInTheDocument();
    expect(screen.getByText("Person 1")).toBeInTheDocument();
  });

  it("marks a person who is no longer eligible and lets the host remove them", () => {
    setup(buildDto({ mode: "SELECTED_PEOPLE", people: [person(1, { stillEligible: false }), person(2)] }));

    expect(screen.getAllByText("notetaker_sharing_person_not_eligible")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('notetaker_sharing_remove_person:Person 1|{"escapeValue":false}'));

    expect(screen.queryByText("Person 1")).not.toBeInTheDocument();
    expect(screen.getByText("Person 2")).toBeInTheDocument();
  });

  it("falls back to the email when a person has no name", () => {
    setup(buildDto({ mode: "SELECTED_PEOPLE", people: [person(1, { name: null })] }));

    expect(screen.getByText("p1@example.com")).toBeInTheDocument();
  });

  it("adds a candidate from the list", () => {
    setup(buildDto({ mode: "SELECTED_PEOPLE" }), {}, [
      { userId: 5, name: "Ann", email: "ann@example.com", avatarUrl: null },
    ]);

    fireEvent.click(screen.getByTestId("notetaker-sharing-candidate-5"));

    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({
      eventTypeId: EVENT_TYPE_ID,
      mode: "SELECTED_PEOPLE",
      userIds: [5],
    });
  });

  it("disables adding at 50 people and shows the limit message", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => person(i + 1));
    setup(buildDto({ mode: "SELECTED_PEOPLE", people: fifty }), {}, [
      { userId: 99, name: "Extra", email: "x@example.com", avatarUrl: null },
    ]);

    expect(screen.getByText("notetaker_sharing_people_limit:50")).toBeInTheDocument();
    expect(screen.getByTestId("notetaker-sharing-candidate-99")).toBeDisabled();
  });

  it("only searches while the picker is shown", () => {
    setup();
    expect(mocks.useCandidates).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));

    fireEvent.click(modeRadio("selected_people"));
    expect(mocks.useCandidates).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("disables save until the draft differs", () => {
    setup(buildDto({ mode: "TEAM" }));
    expect(saveButton()).toBeDisabled();

    fireEvent.click(modeRadio("hosts_only"));
    expect(saveButton()).toBeEnabled();

    fireEvent.click(modeRadio("team"));
    expect(saveButton()).toBeDisabled();
  });

  it("saves a non-selected mode without userIds, even when people were kept in the draft", () => {
    setup(buildDto({ mode: "SELECTED_PEOPLE", people: [person(1)] }));

    fireEvent.click(modeRadio("team"));
    fireEvent.click(saveButton());

    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({
      eventTypeId: EVENT_TYPE_ID,
      mode: "TEAM",
      userIds: undefined,
    });
  });

  it("saves selected people with their ids", () => {
    setup(buildDto({ mode: "SELECTED_PEOPLE", people: [person(1), person(2)] }));

    fireEvent.click(screen.getByLabelText('notetaker_sharing_remove_person:Person 2|{"escapeValue":false}'));
    fireEvent.click(saveButton());

    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({
      eventTypeId: EVENT_TYPE_ID,
      mode: "SELECTED_PEOPLE",
      userIds: [1],
    });
  });

  it("shows who last changed the setting", () => {
    setup(buildDto({ setAt: "2026-05-01T10:00:00.000Z", setByName: "Alex" }));

    expect(screen.getByTestId("notetaker-sharing-set-by").textContent).toContain("notetaker_sharing_set_by");
  });

  it("shows only the date when the person who changed it is unknown", () => {
    setup(buildDto({ setAt: "2026-05-01T10:00:00.000Z", setByName: null }));

    expect(screen.getByTestId("notetaker-sharing-set-by").textContent).toContain("notetaker_sharing_set_at");
  });
});
