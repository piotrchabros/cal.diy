import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerMeetingContactsEditor } from "./NotetakerMeetingContactsEditor";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn<(input: { bookingUid: string; emails: string[] }) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("../hooks/useNotetakerMeetingContacts", () => ({
  useNotetakerMeetingContacts: () => ({ setMeetingContacts: { mutate: mocks.mutate, isPending: false } }),
}));

function renderEditor(overrides: Partial<NotetakerStateDto> = {}) {
  const state = {
    meetingContacts: [
      { email: "cal@x.com", name: "Cal", source: "CALENDAR" },
      { email: "manual@x.com", name: null, source: "MANUAL" },
    ],
    transcriptWebhookSent: false,
    ...overrides,
  } as NotetakerStateDto;
  render(<NotetakerMeetingContactsEditor bookingUid="uid-1" state={state} />);
}

describe("NotetakerMeetingContactsEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows calendar contacts read-only and manual ones in the input", () => {
    renderEditor();

    expect(screen.getByTestId("notetaker-meeting-contacts-calendar").textContent).toContain("cal@x.com");
    expect((screen.getByTestId("notetaker-meeting-contacts-input") as HTMLTextAreaElement).value).toBe(
      "manual@x.com"
    );
  });

  it("saves the parsed manual emails", () => {
    renderEditor();
    fireEvent.change(screen.getByTestId("notetaker-meeting-contacts-input"), {
      target: { value: "New@x.com; other@x.com" },
    });
    fireEvent.click(screen.getByTestId("notetaker-meeting-contacts-save"));

    expect(mocks.mutate).toHaveBeenCalledWith({ bookingUid: "uid-1", emails: ["new@x.com", "other@x.com"] });
  });

  it("does not save invalid input and shows an error", () => {
    renderEditor();
    fireEvent.change(screen.getByTestId("notetaker-meeting-contacts-input"), { target: { value: "bad" } });
    fireEvent.click(screen.getByTestId("notetaker-meeting-contacts-save"));

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("notetaker-meeting-contacts-error").textContent).toBe(
      "notetaker_contact_emails_invalid"
    );
  });

  it("shows the already-sent note only when the transcript was sent", () => {
    renderEditor({ transcriptWebhookSent: true });
    expect(screen.getByTestId("notetaker-meeting-contacts-already-sent")).toBeTruthy();
  });

  it("hides the already-sent note otherwise", () => {
    renderEditor();
    expect(screen.queryByTestId("notetaker-meeting-contacts-already-sent")).toBeNull();
  });
});
