import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotetakerFeatureProvider, useNotetakerFeatureEnabled } from "./NotetakerFeatureContext";

const Probe = (): JSX.Element => <span data-testid="probe">{String(useNotetakerFeatureEnabled())}</span>;

describe("NotetakerFeatureContext", () => {
  it("is disabled outside a provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("false");
  });

  it("is enabled when the provider says so", () => {
    render(
      <NotetakerFeatureProvider enabled>
        <Probe />
      </NotetakerFeatureProvider>
    );
    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("is disabled when the provider says so", () => {
    render(
      <NotetakerFeatureProvider enabled={false}>
        <Probe />
      </NotetakerFeatureProvider>
    );
    expect(screen.getByTestId("probe").textContent).toBe("false");
  });
});
