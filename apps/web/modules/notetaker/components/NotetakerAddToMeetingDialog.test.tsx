import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerAddToMeetingDialog } from "./NotetakerAddToMeetingDialog";

type Options = {
  featureEnabled: boolean;
  teamOptions: { teamId: number; name: string }[];
  defaultDurationMinutes: number;
  maxDurationMinutes: number;
};

const mocks = vi.hoisted(() => ({
  enabled: true,
  options: undefined as unknown,
  dispatch: vi.fn<(input: unknown) => Promise<string | null>>(),
  push: vi.fn<(path: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: { count?: number }) => (vars?.count ? `${key}:${vars.count}` : key),
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

vi.mock("../lib/NotetakerFeatureContext", () => ({
  useNotetakerFeatureEnabled: () => mocks.enabled,
}));

vi.mock("../hooks/useNotetakerAdHoc", () => ({
  useNotetakerAdHoc: () => ({
    options: { data: mocks.options },
    dispatch: mocks.dispatch,
    dispatchToMeeting: { isPending: false },
  }),
}));

const LINK = "https://meet.google.com/abc-defg-hij";

const OPTIONS: Options = {
  featureEnabled: true,
  teamOptions: [{ teamId: 7, name: "Sales" }],
  defaultDurationMinutes: 60,
  maxDurationMinutes: 120,
};

function openDialog(options: Options = OPTIONS) {
  mocks.options = options;
  render(<NotetakerAddToMeetingDialog />);
  fireEvent.click(screen.getByTestId("notetaker-add-to-meeting"));
}

function fillLink(value = LINK) {
  fireEvent.change(screen.getByTestId("notetaker-ad-hoc-link"), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByTestId("notetaker-ad-hoc-send"));
}

function sendButton(): HTMLButtonElement {
  return screen.getByTestId("notetaker-ad-hoc-send") as HTMLButtonElement;
}

describe("NotetakerAddToMeetingDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = true;
    mocks.dispatch.mockResolvedValue("uid-1");
  });

  it("renders nothing when the feature is off", () => {
    mocks.enabled = false;
    render(<NotetakerAddToMeetingDialog />);

    expect(screen.queryByTestId("notetaker-add-to-meeting")).toBeNull();
  });

  it("keeps submit disabled until the link and the acknowledgement are set", () => {
    openDialog();
    expect(sendButton().disabled).toBe(true);

    fillLink();
    expect(sendButton().disabled).toBe(true);

    fireEvent.click(screen.getByTestId("notetaker-ad-hoc-acknowledge"));
    expect(sendButton().disabled).toBe(false);

    fillLink("");
    expect(sendButton().disabled).toBe(true);
  });

  it("offers only the durations up to the maximum and preselects the default", () => {
    openDialog();
    const select = screen.getByTestId("notetaker-ad-hoc-duration") as HTMLSelectElement;

    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "15",
      "30",
      "45",
      "60",
      "90",
      "120",
    ]);
    expect(select.value).toBe("60");
  });

  it("hides the team select when there are no teams", () => {
    openDialog({ ...OPTIONS, teamOptions: [] });

    expect(screen.queryByTestId("notetaker-ad-hoc-team")).toBeNull();
    expect(screen.getByTestId("notetaker-ad-hoc-notice-preview").textContent).toBe(
      "notetaker_ad_hoc_notice_preview"
    );
  });

  it("switches the notice preview when a team is picked", () => {
    openDialog();
    const preview = screen.getByTestId("notetaker-ad-hoc-notice-preview");
    expect(preview.textContent).toBe("notetaker_ad_hoc_notice_preview");

    fireEvent.change(screen.getByTestId("notetaker-ad-hoc-team"), { target: { value: "7" } });
    expect(preview.textContent).toBe("notetaker_ad_hoc_notice_preview_shared");

    fireEvent.change(screen.getByTestId("notetaker-ad-hoc-team"), { target: { value: "" } });
    expect(preview.textContent).toBe("notetaker_ad_hoc_notice_preview");
  });

  it("sends sharingTeamId null for Only me and navigates to the results on success", async () => {
    openDialog();
    fillLink(` ${LINK} `);
    fireEvent.click(screen.getByTestId("notetaker-ad-hoc-acknowledge"));
    submit();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/booking/uid-1/notetaker"));
    expect(mocks.dispatch).toHaveBeenCalledWith({
      meetingUrl: LINK,
      title: undefined,
      durationMinutes: 60,
      sharingTeamId: null,
      acknowledgedNotice: true,
    });
  });

  it("sends the chosen team, title and duration", async () => {
    openDialog();
    fillLink();
    fireEvent.change(screen.getByTestId("notetaker-ad-hoc-title"), { target: { value: " Standup " } });
    fireEvent.change(screen.getByTestId("notetaker-ad-hoc-duration"), { target: { value: "30" } });
    fireEvent.change(screen.getByTestId("notetaker-ad-hoc-team"), { target: { value: "7" } });
    fireEvent.click(screen.getByTestId("notetaker-ad-hoc-acknowledge"));
    submit();

    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
    expect(mocks.dispatch).toHaveBeenCalledWith({
      meetingUrl: LINK,
      title: "Standup",
      durationMinutes: 30,
      sharingTeamId: 7,
      acknowledgedNotice: true,
    });
  });

  it("rejects a link that is not a Google Meet link without calling the server", () => {
    openDialog();
    fillLink("https://zoom.us/j/123");
    fireEvent.click(screen.getByTestId("notetaker-ad-hoc-acknowledge"));
    submit();

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("notetaker-ad-hoc-link-error")).toBeTruthy();
  });

  it("stays open and does not navigate when the dispatch fails", async () => {
    mocks.dispatch.mockResolvedValue(null);
    openDialog();
    fillLink();
    fireEvent.click(screen.getByTestId("notetaker-ad-hoc-acknowledge"));
    submit();

    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("notetaker-add-to-meeting-form")).toBeTruthy();
  });
});
