import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import InstallAppButton from "./InstallAppButton";

const mutate = vi.fn();

vi.mock("@calcom/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/constants")>();
  return { ...actual, WEBAPP_URL: "https://app.example.com" };
});

vi.mock("../../_utils/useAddAppMutation", () => ({
  default: () => ({ mutate }),
}));

// Render the submit path directly instead of the real account dialog.
vi.mock("./AccountDialog", () => ({
  default: ({ handleSubmit }: { handleSubmit: () => void }) => (
    <button data-testid="continue" onClick={handleSubmit} type="button">
      Continue
    </button>
  ),
}));

describe("InstallAppButton returnTo", () => {
  it("installs on the current origin so org-domain users return to their own domain", () => {
    render(
      <InstallAppButton
        render={({ onClick }) => (
          <button data-testid="install" onClick={onClick} type="button">
            Install
          </button>
        )}
      />
    );

    fireEvent.click(screen.getByTestId("install"));
    fireEvent.click(screen.getByTestId("continue"));

    expect(mutate).toHaveBeenCalledTimes(1);
    const returnTo = (mutate.mock.calls[0][0] as { returnTo: string }).returnTo;
    expect(returnTo).toBe(`${window.location.origin}/apps/installation/event-types?slug=msteams`);
    expect(returnTo.startsWith("https://app.example.com")).toBe(false);
  });
});
