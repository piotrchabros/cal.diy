import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerResultsActions } from "./NotetakerResultsActions";

const BOOKING_UID = "booking-uid-1";

const mocks = vi.hoisted(() => ({
  setSharingMutate: vi.fn<(input: { bookingUid: string; shared: boolean }) => void>(),
  exportMutate: vi.fn<(input: { bookingUid: string; format: "markdown" | "html" | "pdf" }) => void>(),
  printMutate: vi.fn<(input: { bookingUid: string; format: "markdown" | "html" }) => void>(),
  deleteMutate: vi.fn<(input: { bookingUid: string }) => void>(),
  pending: { setSharing: false, exportResults: false, printResults: false, deleteResults: false },
}));

// A plain function, not vi.fn: the shared setup runs vi.resetAllMocks() after each test, which would empty a mocked return value.
vi.mock("@calcom/web/modules/notetaker/hooks/useNotetakerMutations", () => ({
  useNotetakerMutations: () => ({
    setSharing: { mutate: mocks.setSharingMutate, isPending: mocks.pending.setSharing },
    exportResults: { mutate: mocks.exportMutate, isPending: mocks.pending.exportResults },
    printResults: { mutate: mocks.printMutate, isPending: mocks.pending.printResults },
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
    mocks.pending.printResults = false;
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

  it("shows only the export action and a notice to a shared viewer", () => {
    renderActions({ viewerRole: "SHARED_VIEWER", sharedWithAttendees: false, sessionStatus: "READY" });

    expect(screen.getByTestId("notetaker-export-button")).toBeInTheDocument();
    expect(screen.getByTestId("notetaker-shared-viewer-notice")).toHaveTextContent(
      "notetaker_shared_viewer_notice"
    );
    expect(screen.queryByTestId("notetaker-share-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-delete-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dialog-confirmation")).not.toBeInTheDocument();
  });

  it("shows no shared viewer notice to a host or an attendee", () => {
    const { unmount } = renderActions();
    expect(screen.queryByTestId("notetaker-shared-viewer-notice")).not.toBeInTheDocument();
    unmount();

    renderActions({ viewerRole: "ATTENDEE" });
    expect(screen.queryByTestId("notetaker-shared-viewer-notice")).not.toBeInTheDocument();
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

  // Radix opens its menu on pointerdown, which fireEvent.click does not dispatch.
  function openExportMenu() {
    const trigger = screen.getByTestId("notetaker-export-button");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.keyDown(trigger, { key: "Enter" });
  }

  it("lists the markdown, html, pdf and print items in the export menu", () => {
    renderActions();

    expect(screen.getByTestId("notetaker-export-button")).toHaveTextContent("notetaker_export");
    openExportMenu();

    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    expect(screen.getByTestId("notetaker-export-markdown")).toHaveTextContent("notetaker_export_markdown");
    expect(screen.getByTestId("notetaker-export-html")).toHaveTextContent("notetaker_export_html");
    expect(screen.getByTestId("notetaker-export-pdf")).toHaveTextContent("notetaker_export_pdf");
    expect(screen.getByTestId("notetaker-print")).toHaveTextContent("notetaker_print");
  });

  it("exports the results as markdown", () => {
    renderActions();
    openExportMenu();

    fireEvent.click(screen.getByTestId("notetaker-export-markdown"));

    expect(mocks.exportMutate).toHaveBeenCalledTimes(1);
    expect(mocks.exportMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, format: "markdown" });
  });

  it("exports the results as html", () => {
    renderActions();
    openExportMenu();

    fireEvent.click(screen.getByTestId("notetaker-export-html"));

    expect(mocks.exportMutate).toHaveBeenCalledTimes(1);
    expect(mocks.exportMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, format: "html" });
  });

  it("exports the results as pdf", () => {
    renderActions();
    openExportMenu();

    fireEvent.click(screen.getByTestId("notetaker-export-pdf"));

    expect(mocks.exportMutate).toHaveBeenCalledTimes(1);
    expect(mocks.exportMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, format: "pdf" });
  });

  it("prints the results through the print mutation", () => {
    renderActions();
    openExportMenu();

    fireEvent.click(screen.getByTestId("notetaker-print"));

    expect(mocks.printMutate).toHaveBeenCalledTimes(1);
    expect(mocks.printMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, format: "html" });
    expect(mocks.exportMutate).not.toHaveBeenCalled();
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
