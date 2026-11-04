import enTranslations from "@calcom/i18n/locales/en/common.json";
import type {
  NotetakerCalendarAutoJoinSettingDto,
  NotetakerCalendarAutoJoinSettingsDto,
} from "@calcom/lib/dto/NotetakerCalendarAutoJoinDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerCalendarAutoJoinSwitch } from "./NotetakerCalendarAutoJoinSwitch";

type HookResult = {
  query: { data: NotetakerCalendarAutoJoinSettingsDto | undefined };
  save: { mutate: (input: object) => void; isPending: boolean };
  findCalendar: (integration: string, externalId: string) => NotetakerCalendarAutoJoinSettingDto | null;
};

const mocks = vi.hoisted(() => ({
  useNotetakerCalendarAutoJoin: vi.fn<() => HookResult>(),
  mutate: vi.fn<(input: object) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("../hooks/useNotetakerCalendarAutoJoin", () => ({
  useNotetakerCalendarAutoJoin: mocks.useNotetakerCalendarAutoJoin,
}));

function buildCalendar(
  overrides: Partial<NotetakerCalendarAutoJoinSettingDto> = {}
): NotetakerCalendarAutoJoinSettingDto {
  return {
    selectedCalendarId: "sc-1",
    integration: "google_calendar",
    externalId: "a@b.c",
    enabled: false,
    sharingTeamId: null,
    supported: true,
    lastPollFailed: false,
    ...overrides,
  };
}

function setup(
  calendar: NotetakerCalendarAutoJoinSettingDto | null,
  settings: Partial<NotetakerCalendarAutoJoinSettingsDto> = {},
  isPending = false
): void {
  const data: NotetakerCalendarAutoJoinSettingsDto = {
    available: true,
    teamOptions: [
      { teamId: 3, name: "Sales" },
      { teamId: 4, name: "Support" },
    ],
    calendars: calendar ? [calendar] : [],
    ...settings,
  };
  mocks.useNotetakerCalendarAutoJoin.mockReturnValue({
    query: { data },
    save: { mutate: mocks.mutate, isPending },
    findCalendar: (integration, externalId) =>
      data.calendars.find((c) => c.integration === integration && c.externalId === externalId) ?? null,
  });
  render(<NotetakerCalendarAutoJoinSwitch integration="google_calendar" externalId="a@b.c" />);
}

describe("NotetakerCalendarAutoJoinSwitch", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
  });

  it("renders nothing when auto-join is not available", () => {
    setup(buildCalendar(), { available: false });

    expect(screen.queryByTestId("notetaker-calendar-auto-join")).not.toBeInTheDocument();
  });

  it("renders nothing while the settings load", () => {
    mocks.useNotetakerCalendarAutoJoin.mockReturnValue({
      query: { data: undefined },
      save: { mutate: mocks.mutate, isPending: false },
      findCalendar: () => null,
    });
    render(<NotetakerCalendarAutoJoinSwitch integration="google_calendar" externalId="a@b.c" />);

    expect(screen.queryByTestId("notetaker-calendar-auto-join")).not.toBeInTheDocument();
  });

  it("renders nothing for a calendar without an entry", () => {
    setup(null);

    expect(screen.queryByTestId("notetaker-calendar-auto-join")).not.toBeInTheDocument();
  });

  it("renders nothing for an unsupported integration", () => {
    setup(buildCalendar({ supported: false }));

    expect(screen.queryByTestId("notetaker-calendar-auto-join")).not.toBeInTheDocument();
  });

  it("shows an unchecked switch and the description, without the share select, when off", () => {
    setup(buildCalendar());

    const section = screen.getByTestId("notetaker-calendar-auto-join");
    expect(section).toHaveTextContent("notetaker_calendar_auto_join_label");
    expect(section).toHaveTextContent("notetaker_calendar_auto_join_description");
    expect(screen.getByTestId("notetaker-calendar-auto-join-toggle")).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(screen.queryByTestId("notetaker-calendar-auto-join-share")).not.toBeInTheDocument();
  });

  it("turns auto-join on keeping the sharing team", () => {
    setup(buildCalendar({ sharingTeamId: 4 }));

    fireEvent.click(screen.getByTestId("notetaker-calendar-auto-join-toggle"));

    expect(mocks.mutate).toHaveBeenCalledWith({
      selectedCalendarId: "sc-1",
      enabled: true,
      sharingTeamId: 4,
    });
  });

  it("turns auto-join off", () => {
    setup(buildCalendar({ enabled: true }));

    fireEvent.click(screen.getByTestId("notetaker-calendar-auto-join-toggle"));

    expect(mocks.mutate).toHaveBeenCalledWith({
      selectedCalendarId: "sc-1",
      enabled: false,
      sharingTeamId: null,
    });
  });

  it("disables the switch and the select while saving", () => {
    setup(buildCalendar({ enabled: true }), {}, true);

    expect(screen.getByTestId("notetaker-calendar-auto-join-toggle")).toBeDisabled();
    expect(screen.getByTestId("notetaker-calendar-auto-join-share")).toBeDisabled();
  });

  it("offers only me and the team options when on", () => {
    setup(buildCalendar({ enabled: true, sharingTeamId: 3 }));

    const select = screen.getByTestId("notetaker-calendar-auto-join-share") as HTMLSelectElement;
    expect(select.value).toBe("3");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "notetaker_calendar_auto_join_share_only_me",
      "Sales",
      "Support",
    ]);
  });

  it("saves the chosen team", () => {
    setup(buildCalendar({ enabled: true }));

    fireEvent.change(screen.getByTestId("notetaker-calendar-auto-join-share"), { target: { value: "4" } });

    expect(mocks.mutate).toHaveBeenCalledWith({
      selectedCalendarId: "sc-1",
      enabled: true,
      sharingTeamId: 4,
    });
  });

  it("saves only me as a null team", () => {
    setup(buildCalendar({ enabled: true, sharingTeamId: 3 }));

    fireEvent.change(screen.getByTestId("notetaker-calendar-auto-join-share"), { target: { value: "" } });

    expect(mocks.mutate).toHaveBeenCalledWith({
      selectedCalendarId: "sc-1",
      enabled: true,
      sharingTeamId: null,
    });
  });

  it("warns when the last poll failed", () => {
    setup(buildCalendar({ lastPollFailed: true }));

    expect(screen.getByTestId("notetaker-calendar-auto-join-poll-failed")).toHaveTextContent(
      "notetaker_calendar_auto_join_poll_failed"
    );
  });

  it("shows no warning when the last poll succeeded", () => {
    setup(buildCalendar());

    expect(screen.queryByTestId("notetaker-calendar-auto-join-poll-failed")).not.toBeInTheDocument();
  });

  it("has every key in the English catalogue", () => {
    const catalogue: Record<string, unknown> = enTranslations;
    for (const key of [
      "notetaker_calendar_auto_join_badge",
      "notetaker_calendar_auto_join_label",
      "notetaker_calendar_auto_join_description",
      "notetaker_calendar_auto_join_share_label",
      "notetaker_calendar_auto_join_share_only_me",
      "notetaker_calendar_auto_join_poll_failed",
      "notetaker_calendar_auto_join_save_failed",
    ]) {
      expect(catalogue[key]).toBeTruthy();
    }
  });
});
