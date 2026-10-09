import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerResultsActions } from "./NotetakerResultsActions";

const BOOKING_UID = "booking-uid-1";

const mocks = vi.hoisted(() => ({
  setSharingMutate: vi.fn<(input: { bookingUid: string; shared: boolean }) => void>(),
  exportMutate: vi.fn<(input: { bookingUid: string; format: "markdown" }) => void>(),
  deleteMutate: vi.fn<(input: { bookingUid: string }) => void>(),
  pending: { setSharing: false, exportResults: false, deleteResults: false },
}));

// A plain function, not vi.fn: the shared setup runs vi.resetAllMocks() after each test, which would empty a mocked return value.
vi.mock("@calcom/web/modules/notetaker/hooks/useNotetakerMutations", () => ({
  useNotetakerMutations: () => ({
    setSharing: { mutate: mocks.setSharingMutate, isPending: mocks.pending.setSharing },
    exportResults: { mutate: mocks.exportMutate, isPending: mocks.pending.exportResults },
    deleteResults: { mutate: mocks.deleteMutate, isPending: mocks.pending.deleteResults },
  }),
}));

type Props = Parameters<typeof NotetakerResultsActions>[0];

function renderActions(overrides: Partial<Props> = {}) {
  return render(
    <NotetakerResultsActions
      bookingUid={BOOKING_UID}
      viewerRole="HOST"
      sharedWithAttendees={false}
      sessionStatus={null}
      {...overrides}
    />
  );
}

describe("NotetakerResultsActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pending.setSharing = false;
    mocks.pending.exportResults = false;
    mocks.pending.deleteResults = false;
  });

  it("shows the export, share and delete actions to a host", () => {
    renderActions();

    expect(screen.getByTestId("notetaker-results-actions")).toBeInTheDocument();
    expect(screen.getByTestId("notetaker-export-button")).toBeInTheDocument();
    expect(screen.getByTestId("notetaker-share-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("notetaker-delete-button")).toBeInTheDocument();
  });

  it("shows only the export action to an attendee, even with a live session", () => {
    renderActions({ viewerRole: "ATTENDEE", sharedWithAttendees: true, sessionStatus: "TRANSCRIBING" });

    expect(screen.getByTestId("notetaker-export-button")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-share-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-shared-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-delete-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dialog-confirmation")).not.toBeInTheDocument();
  });

  it("offers to share when the results are not shared", () => {
    renderActions({ sharedWithAttendees: false });

    const toggle = screen.getByTestId("notetaker-share-toggle");
    expect(toggle).toHaveTextContent("notetaker_share_with_attendees");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("notetaker_share_description")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-shared-status")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(mocks.setSharingMutate).toHaveBeenCalledTimes(1);
    expect(mocks.setSharingMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, shared: true });
  });

  it("offers to stop sharing when the results are shared", () => {
    renderActions({ sharedWithAttendees: true });

    const toggle = screen.getByTestId("notetaker-share-toggle");
    expect(toggle).toHaveTextContent("notetaker_stop_sharing");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("notetaker-shared-status")).toHaveTextContent("notetaker_shared_status");
    expect(screen.queryByText("notetaker_share_description")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(mocks.setSharingMutate).toHaveBeenCalledTimes(1);
    expect(mocks.setSharingMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, shared: false });
  });

  it("disables the share toggle while sharing is being updated", () => {
    mocks.pending.setSharing = true;
    renderActions();

    expect(screen.getByTestId("notetaker-share-toggle")).toBeDisabled();
  });

  it("exports the results as markdown", () => {
    renderActions();

    fireEvent.click(screen.getByTestId("notetaker-export-button"));

    expect(mocks.exportMutate).toHaveBeenCalledTimes(1);
    expect(mocks.exportMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, format: "markdown" });
  });

  it("opens the confirmation dialog without deleting", () => {
    renderActions();

    fireEvent.click(screen.getByTestId("notetaker-delete-button"));

    expect(screen.getByText("notetaker_delete_results_confirm_title")).toBeInTheDocument();
    expect(screen.getByText("notetaker_delete_results_confirm_description")).toBeInTheDocument();
    expect(mocks.deleteMutate).not.toHaveBeenCalled();
  });

  it("deletes once after the host confirms", () => {
    renderActions();

    fireEvent.click(screen.getByTestId("notetaker-delete-button"));
    fireEvent.click(screen.getByTestId("dialog-confirmation"));

    expect(mocks.deleteMutate).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID });
  });

  it("closes the dialog without deleting when the host cancels", () => {
    renderActions();

    fireEvent.click(screen.getByTestId("notetaker-delete-button"));
    fireEvent.click(screen.getByTestId("dialog-rejection"));

    expect(mocks.deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByText("notetaker_delete_results_confirm_title")).not.toBeInTheDocument();
  });

  it.each<NotetakerSessionStatusDto>([
    "SCHEDULED",
    "WAITING_TO_BE_ADMITTED",
    "TRANSCRIBING",
    "PROCESSING",
  ])("disables delete while the session is %s", (sessionStatus) => {
    renderActions({ sessionStatus });

    expect(screen.getByTestId("notetaker-delete-button")).toBeDisabled();
  });

  it.each<NotetakerSessionStatusDto | null>([
    "READY",
    "ENDED_EARLY",
    "FAILED",
    null,
  ])("enables delete when the session status is %s", (sessionStatus) => {
    renderActions({ sessionStatus });

    expect(screen.getByTestId("notetaker-delete-button")).toBeEnabled();
  });

  it("disables delete while a deletion is in flight", () => {
    mocks.pending.deleteResults = true;
    renderActions();

    expect(screen.getByTestId("notetaker-delete-button")).toBeDisabled();
  });
});
