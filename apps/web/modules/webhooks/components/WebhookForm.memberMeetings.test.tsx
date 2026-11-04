import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import WebhookForm from "./WebhookForm";

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("./WebhookTestDisclosure", () => ({ default: () => null }));

describe("WebhookForm include member meetings switch", () => {
  it("is hidden without a teamId", () => {
    render(<WebhookForm onSubmit={vi.fn()} />);

    expect(screen.queryByTestId("include-member-meetings-switch")).toBeNull();
  });

  it("is enabled for a team webhook by default", () => {
    render(<WebhookForm onSubmit={vi.fn()} teamId={5} />);

    expect(screen.getByTestId("include-member-meetings-switch")).not.toBeDisabled();
    expect(screen.queryByTestId("include-member-meetings-admin-only")).toBeNull();
  });

  it("is disabled with a hint when the user cannot manage the team", () => {
    render(<WebhookForm onSubmit={vi.fn()} teamId={5} canManageMemberMeetings={false} />);

    expect(screen.getByTestId("include-member-meetings-switch")).toBeDisabled();
    expect(screen.getByTestId("include-member-meetings-admin-only")).toBeInTheDocument();
  });
});
