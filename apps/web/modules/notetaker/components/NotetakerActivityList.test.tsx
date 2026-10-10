import type { NotetakerActivityActionDto, NotetakerActivityDto } from "@calcom/lib/dto/NotetakerActivityDto";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerActivityList } from "./NotetakerActivityList";

type ActivityQuery = { data: NotetakerActivityDto[] | undefined; isPending: boolean; isError: boolean };

const BOOKING_UID = "booking-uid-1";
const LIST_ID = "notetaker-activity-list";
const ITEM_ID = "notetaker-activity-item";

const ACTION_KEYS: Record<NotetakerActivityActionDto, string> = {
  ENABLED: "notetaker_activity_enabled",
  DISABLED: "notetaker_activity_disabled",
  STOPPED: "notetaker_activity_stopped",
  SHARED: "notetaker_activity_shared",
  SHARING_REVOKED: "notetaker_activity_sharing_revoked",
  EXPORTED: "notetaker_activity_exported",
  DELETED: "notetaker_activity_deleted",
  SUMMARY_REQUESTED: "notetaker_activity_summary_requested",
  SHARED_VIEWED: "notetaker_activity_shared_viewed",
  SHARING_MODE_CHANGED: "notetaker_activity_sharing_mode_changed",
  SHARING_PEOPLE_CHANGED: "notetaker_activity_sharing_people_changed",
};
const ALL_ACTIONS = Object.keys(ACTION_KEYS) as NotetakerActivityActionDto[];

const UNKNOWN_ACTOR_KEY = "notetaker_activity_actor_unknown";
const PARTICIPANT_ACTOR_KEY = "notetaker_activity_actor_participant";
const SYSTEM_ACTOR_KEY = "notetaker_activity_actor_system";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<(input: { bookingUid: string }, options: { retry: boolean }) => ActivityQuery>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined
        ? key
        : `${key}|${Object.entries(options)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("|")}`,
    i18n: { language: "en" },
  }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    viewer: {
      notetaker: {
        getActivity: { useQuery: mocks.useQuery },
      },
    },
  },
}));

function buildActivity(overrides: Partial<NotetakerActivityDto> = {}): NotetakerActivityDto {
  return {
    id: "activity-1",
    action: "ENABLED",
    actorType: "USER",
    actorName: "Alice",
    createdAt: "2026-03-04T10:15:00.000Z",
    detail: null,
    ...overrides,
  };
}

function buildQuery(overrides: Partial<ActivityQuery> = {}): ActivityQuery {
  return { data: [buildActivity()], isPending: false, isError: false, ...overrides };
}

function renderList(query: ActivityQuery): ReturnType<typeof render> {
  mocks.useQuery.mockReturnValue(query);
  return render(<NotetakerActivityList bookingUid={BOOKING_UID} />);
}

function getItems(): HTMLElement[] {
  return screen.queryAllByTestId(ITEM_ID);
}

function getSpans(item: HTMLElement): HTMLElement[] {
  return Array.from(item.querySelectorAll<HTMLElement>(":scope > span"));
}

function renderSingle(activity: NotetakerActivityDto): HTMLElement[] {
  renderList(buildQuery({ data: [activity] }));
  return getSpans(getItems()[0]);
}

describe("NotetakerActivityList", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("queries the activity for the booking without retrying", () => {
    renderList(buildQuery());

    expect(mocks.useQuery).toHaveBeenCalledWith({ bookingUid: BOOKING_UID }, { retry: false });
  });

  it("renders the section with the title heading", () => {
    renderList(buildQuery());

    const section = screen.getByTestId(LIST_ID);
    expect(section.tagName).toBe("SECTION");
    expect(section.querySelector("h3")?.textContent).toBe("notetaker_activity_title");
  });

  it("renders one item per record in the given order inside an ordered list", () => {
    renderList(
      buildQuery({
        data: [
          buildActivity({ id: "a", action: "SHARED", createdAt: "2026-03-04T10:00:00.000Z" }),
          buildActivity({ id: "b", action: "ENABLED", createdAt: "2026-03-01T10:00:00.000Z" }),
          buildActivity({ id: "c", action: "DELETED", createdAt: "2026-03-09T10:00:00.000Z" }),
        ],
      })
    );

    const items = getItems();
    expect(items).toHaveLength(3);
    expect(items[0].parentElement?.tagName).toBe("OL");
    expect(items.map((item) => getSpans(item)[0].textContent)).toEqual([
      ACTION_KEYS.SHARED,
      ACTION_KEYS.ENABLED,
      ACTION_KEYS.DELETED,
    ]);
  });

  it.each(ALL_ACTIONS)("renders the action label for %s", (action) => {
    const spans = renderSingle(buildActivity({ action }));

    expect(spans[0].textContent).toBe(ACTION_KEYS[action]);
  });

  it("renders three spans per item", () => {
    const spans = renderSingle(buildActivity());

    expect(spans).toHaveLength(3);
  });

  it("shows the name of a user actor", () => {
    const spans = renderSingle(buildActivity({ actorType: "USER", actorName: "Alice" }));

    expect(spans[1].textContent).toBe("Alice");
  });

  it("falls back to the unknown actor label for a user without a name", () => {
    const spans = renderSingle(buildActivity({ actorType: "USER", actorName: null }));

    expect(spans[1].textContent).toBe(UNKNOWN_ACTOR_KEY);
  });

  it("falls back to the unknown actor label for a user with a whitespace-only name", () => {
    const spans = renderSingle(buildActivity({ actorType: "USER", actorName: "   " }));

    expect(spans[1].textContent).toBe(UNKNOWN_ACTOR_KEY);
  });

  it("shows the participant label and ignores the name for a participant actor", () => {
    const spans = renderSingle(buildActivity({ actorType: "PARTICIPANT", actorName: "Mallory" }));

    expect(spans[1].textContent).toBe(PARTICIPANT_ACTOR_KEY);
    expect(screen.queryByText("Mallory")).not.toBeInTheDocument();
  });

  it("shows the system label and ignores the name for a system actor", () => {
    const spans = renderSingle(buildActivity({ actorType: "SYSTEM", actorName: "Mallory" }));

    expect(spans[1].textContent).toBe(SYSTEM_ACTOR_KEY);
    expect(screen.queryByText("Mallory")).not.toBeInTheDocument();
  });

  it("renders the timestamp in a time element formatted for the locale", () => {
    const createdAt = "2026-03-04T10:15:00.000Z";
    const spans = renderSingle(buildActivity({ createdAt }));

    const time = spans[2].querySelector("time");
    // Computed here rather than hard-coded because the host timezone is not necessarily UTC.
    const expected = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(createdAt)
    );
    expect(time).not.toBeNull();
    expect(time?.getAttribute("datetime")).toBe(createdAt);
    expect(time?.textContent).toBe(expected);
  });

  it("shows the empty message and no list when there is no activity", () => {
    const { container } = renderList(buildQuery({ data: [] }));

    expect(screen.getByTestId(LIST_ID)).toBeInTheDocument();
    expect(container.querySelector("h3")?.textContent).toBe("notetaker_activity_title");
    expect(screen.getByText("notetaker_activity_empty")).toBeInTheDocument();
    expect(getItems()).toHaveLength(0);
    expect(container.querySelector("ol")).toBeNull();
  });

  it("renders nothing while the activity is loading", () => {
    const { container } = renderList(buildQuery({ data: undefined, isPending: true }));

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the query fails", () => {
    const { container } = renderList(buildQuery({ data: undefined, isError: true }));

    expect(container).toBeEmptyDOMElement();
  });

  it("renders an actor name as plain text, not markup", () => {
    const { container } = renderList(
      buildQuery({ data: [buildActivity({ actorType: "USER", actorName: "<b>Eve</b>" })] })
    );

    expect(getSpans(getItems()[0])[1].textContent).toBe("<b>Eve</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  it("never renders the detail payload", () => {
    const { container } = renderList(
      buildQuery({ data: [buildActivity({ detail: { reason: "SECRET_REASON_CODE" } })] })
    );

    expect(container.textContent).not.toContain("SECRET_REASON_CODE");
  });

  describe("sharing change detail", () => {
    const DETAIL_ID = "notetaker-activity-detail";

    function getDetailLines(): string[] {
      return screen.queryAllByTestId(DETAIL_ID).map((line) => line.textContent ?? "");
    }

    it("shows the two mode labels for a mode change", () => {
      renderSingle(
        buildActivity({
          action: "SHARING_MODE_CHANGED",
          detail: { previousMode: "HOSTS_ONLY", newMode: "TEAM", addedUserNames: [], removedUserNames: [] },
        })
      );

      expect(getDetailLines()).toEqual([
        "notetaker_activity_sharing_mode_detail|previousMode=notetaker_sharing_mode_hosts_only|newMode=notetaker_sharing_mode_team",
      ]);
    });

    it("shows added and removed names for a people change and no mode line", () => {
      renderSingle(
        buildActivity({
          action: "SHARING_PEOPLE_CHANGED",
          detail: {
            previousMode: "SELECTED_PEOPLE",
            newMode: "SELECTED_PEOPLE",
            addedUserNames: ["Ann", "Bob"],
            removedUserNames: ["Cy"],
          },
        })
      );

      expect(getDetailLines()).toEqual([
        'notetaker_activity_sharing_people_added|names=Ann, Bob|interpolation={"escapeValue":false}',
        'notetaker_activity_sharing_people_removed|names=Cy|interpolation={"escapeValue":false}',
      ]);
    });

    it("omits the lines for empty name lists", () => {
      renderSingle(
        buildActivity({
          action: "SHARING_PEOPLE_CHANGED",
          detail: {
            previousMode: "SELECTED_PEOPLE",
            newMode: "SELECTED_PEOPLE",
            addedUserNames: ["Ann"],
            removedUserNames: [],
          },
        })
      );

      expect(getDetailLines()).toEqual([
        'notetaker_activity_sharing_people_added|names=Ann|interpolation={"escapeValue":false}',
      ]);
    });

    it("shows the names after the mode line when a mode change also changes the list", () => {
      renderSingle(
        buildActivity({
          action: "SHARING_MODE_CHANGED",
          detail: {
            previousMode: "TEAM",
            newMode: "SELECTED_PEOPLE",
            addedUserNames: ["Ann"],
            removedUserNames: [],
          },
        })
      );

      expect(getDetailLines()).toEqual([
        "notetaker_activity_sharing_mode_detail|previousMode=notetaker_sharing_mode_team|newMode=notetaker_sharing_mode_selected_people",
        'notetaker_activity_sharing_people_added|names=Ann|interpolation={"escapeValue":false}',
      ]);
    });

    it.each([
      ["null", null],
      ["an unrelated object", { reason: "x" }],
      [
        "an unknown mode",
        { previousMode: "NOPE", newMode: "TEAM", addedUserNames: [], removedUserNames: [] },
      ],
    ])("shows the label only when the detail is %s", (_name, detail) => {
      renderSingle(buildActivity({ action: "SHARING_MODE_CHANGED", detail }));

      expect(getDetailLines()).toEqual([]);
      expect(getSpans(getItems()[0])[0].textContent).toBe(ACTION_KEYS.SHARING_MODE_CHANGED);
    });

    it("keeps the three spans per item when a detail is shown", () => {
      const spans = renderSingle(
        buildActivity({
          action: "SHARING_MODE_CHANGED",
          detail: { previousMode: "TEAM", newMode: "HOSTS_ONLY", addedUserNames: [], removedUserNames: [] },
        })
      );

      expect(spans).toHaveLength(3);
    });

    it("renders names as plain text, not markup", () => {
      const { container } = renderList(
        buildQuery({
          data: [
            buildActivity({
              action: "SHARING_PEOPLE_CHANGED",
              detail: {
                previousMode: "SELECTED_PEOPLE",
                newMode: "SELECTED_PEOPLE",
                addedUserNames: ["<b>Eve</b>"],
                removedUserNames: [],
              },
            }),
          ],
        })
      );

      expect(container.querySelector("b")).toBeNull();
      expect(getDetailLines()[0]).toContain("<b>Eve</b>");
    });

    it("shows no detail line for other actions even with a matching payload", () => {
      renderSingle(
        buildActivity({
          action: "SHARED",
          detail: {
            previousMode: "TEAM",
            newMode: "HOSTS_ONLY",
            addedUserNames: ["Ann"],
            removedUserNames: [],
          },
        })
      );

      expect(getDetailLines()).toEqual([]);
    });
  });
});
