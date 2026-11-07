import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamPublicPreview } from "./team-public-preview";

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

describe("TeamPublicPreview", () => {
  it("renders the team URL on the given host", () => {
    render(<TeamPublicPreview name="Acme" bio="" slug=" sales " host="acme.test" />);
    expect(screen.getByText("acme.test/team/sales")).toBeTruthy();
  });
});
