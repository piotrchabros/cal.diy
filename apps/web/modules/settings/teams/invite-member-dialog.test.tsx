import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import InviteMemberDialog from "./invite-member-dialog";

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, isLocaleReady: true, i18n: { exists: () => false } }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    viewer: {
      teams: {
        inviteMember: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: vi.fn() }));

vi.mock("@calcom/features/components/controlled-dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock("@calcom/ui/components/dialog", () => ({
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

describe("InviteMemberDialog", () => {
  it("labels the email input so it can be found by its label", () => {
    render(<InviteMemberDialog teamId={1} open onOpenChange={vi.fn()} onInvited={vi.fn()} />);

    const emailInput = screen.getByLabelText("email_address");
    expect(emailInput).toHaveAttribute("type", "email");
    expect(emailInput).toHaveAttribute("name", "email");
  });

  it("connects the role label to its select", () => {
    render(<InviteMemberDialog teamId={1} open onOpenChange={vi.fn()} onInvited={vi.fn()} />);

    expect(screen.getByLabelText("role")).toHaveAttribute("role", "combobox");
  });
});
