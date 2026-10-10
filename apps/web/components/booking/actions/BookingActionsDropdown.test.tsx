import { NotetakerFeatureProvider } from "@calcom/web/modules/notetaker/lib/NotetakerFeatureContext";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BookingItemProps } from "../types";
import { BookingActionsDropdown } from "./BookingActionsDropdown";
import { BookingActionsStoreProvider } from "./BookingActionsStoreProvider";

vi.mock("@calcom/lib/hooks/useLocale", () => ({ useLocale: () => ({ t: (key: string) => key }) }));
vi.mock("@calcom/trpc/react", () => {
  const mutation = { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }) };
  return {
    trpc: {
      useUtils: () => ({}),
      viewer: { loggedInViewerRouter: { markNoShow: mutation }, bookings: { editLocation: mutation } },
    },
  };
});
vi.mock("../hooks/useBookingConfirmation", () => ({
  useBookingConfirmation: () => ({
    bookingConfirm: vi.fn(),
    handleReject: vi.fn(),
    rejectionDialogIsOpen: false,
    setRejectionDialogIsOpen: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("@calcom/ui/components/button", () => ({ Button: () => <button type="button" /> }));
vi.mock("@calcom/ui/components/dialog", () => ({
  Dialog: () => null,
  DialogClose: () => null,
  DialogContent: () => null,
  DialogFooter: () => null,
}));
vi.mock("@calcom/ui/components/toast", () => ({ showToast: vi.fn() }));
vi.mock("@calcom/ui/components/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@calcom/ui/components/dropdown", () => ({
  Dropdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuPortal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownItem: ({
    children,
    href,
    "data-testid": testId,
  }: {
    children: ReactNode;
    href?: string;
    "data-testid"?: string;
  }) =>
    href ? (
      <a href={href} data-testid={testId}>
        {children}
      </a>
    ) : (
      <button type="button" data-testid={testId}>
        {children}
      </button>
    ),
}));
vi.mock("@components/dialog/AddGuestsDialog", () => ({ AddGuestsDialog: () => null }));
vi.mock("@components/dialog/CancelBookingDialog", () => ({ CancelBookingDialog: () => null }));
vi.mock("@components/dialog/ChargeCardDialog", () => ({ ChargeCardDialog: () => null }));
vi.mock("@components/dialog/EditLocationDialog", () => ({ EditLocationDialog: () => null }));
vi.mock("@components/dialog/ReassignDialog", () => ({ ReassignDialog: () => null }));
vi.mock("@components/dialog/RejectionReasonDialog", () => ({ RejectionReasonDialog: () => null }));
vi.mock("@components/dialog/ReportBookingDialog", () => ({ ReportBookingDialog: () => null }));
vi.mock("@components/dialog/RescheduleDialog", () => ({ RescheduleDialog: () => null }));
vi.mock("@components/dialog/WrongAssignmentDialog", () => ({ WrongAssignmentDialog: () => null }));

const booking = {
  id: 1,
  uid: "booking-123",
  title: "Past meeting",
  startTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  endTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  status: "ACCEPTED",
  fromReschedule: null,
  recurringEventId: null,
  isRecorded: false,
  location: null,
  payment: [],
  attendees: [],
  seatsReferences: [],
  user: { id: 7 },
  eventType: { disableCancelling: false, disableRescheduling: false },
  loggedInUser: { userId: 7, userEmail: "host@example.com" },
} as unknown as BookingItemProps;

function renderDropdown(wrapper?: (children: ReactNode) => ReactNode): void {
  const dropdown = (
    <BookingActionsStoreProvider>
      <BookingActionsDropdown booking={booking} context="details" />
    </BookingActionsStoreProvider>
  );
  render(<>{wrapper ? wrapper(dropdown) : dropdown}</>);
}

describe("BookingActionsDropdown notetaker results item", () => {
  it("links to the booking notetaker page when the feature is enabled", () => {
    renderDropdown((children) => <NotetakerFeatureProvider enabled>{children}</NotetakerFeatureProvider>);

    const item = screen.getByTestId("notetaker_results");
    expect(item.tagName).toBe("A");
    expect(item.getAttribute("href")).toBe("/booking/booking-123/notetaker");
  });

  it("omits the item without the feature provider", () => {
    renderDropdown();

    expect(screen.queryByTestId("notetaker_results")).toBeNull();
    expect(screen.getByTestId("meeting_session_details")).toBeTruthy();
  });
});
