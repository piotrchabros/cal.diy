import type { NotetakerAccessDto } from "@calcom/lib/dto/NotetakerStateDto";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotetakerAccessSummary } from "./NotetakerAccessSummary";

// The shared setup's `t` drops interpolation values; this makes them observable.
vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

function lines(): string[] {
  const section = screen.getByTestId("notetaker-access-summary");
  return within(section)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

describe("NotetakerAccessSummary", () => {
  it("shows the title and only the hosts line when nobody else has access", () => {
    render(<NotetakerAccessSummary access={{ attendees: false, colleagues: null }} />);

    expect(screen.getByTestId("notetaker-access-summary")).toHaveTextContent("notetaker_access_title");
    expect(lines()).toEqual(["notetaker_access_hosts"]);
  });

  it("adds the attendees line when a host shared with attendees", () => {
    render(<NotetakerAccessSummary access={{ attendees: true, colleagues: null }} />);

    expect(lines()).toEqual(["notetaker_access_hosts", "notetaker_access_attendees"]);
  });

  it("adds the team line with the team name", () => {
    render(
      <NotetakerAccessSummary
        access={{ attendees: false, colleagues: { route: "TEAM", teamName: "Sales" } }}
      />
    );

    expect(lines()).toEqual([
      "notetaker_access_hosts",
      'notetaker_access_team:{"teamName":"Sales","interpolation":{"escapeValue":false}}',
    ]);
  });

  it("turns off i18n escaping for the team name, which React escapes on its own", () => {
    const teamName = "user-id-17's Team";
    render(<NotetakerAccessSummary access={{ attendees: false, colleagues: { route: "TEAM", teamName } }} />);

    const teamLine = lines()[1] ?? "";
    const options: unknown = JSON.parse(teamLine.replace("notetaker_access_team:", ""));

    expect(options).toEqual({ teamName, interpolation: { escapeValue: false } });
  });

  it("lists the selected people joined with a comma", () => {
    const access: NotetakerAccessDto = {
      attendees: true,
      colleagues: { route: "SELECTED_PEOPLE", people: [{ name: "Ada" }, { name: "Bo" }] },
    };
    render(<NotetakerAccessSummary access={access} />);

    expect(lines()).toEqual([
      "notetaker_access_hosts",
      "notetaker_access_attendees",
      'notetaker_access_selected_people:{"names":"Ada, Bo","interpolation":{"escapeValue":false}}',
    ]);
  });

  it("shows the none line when no selected person has access", () => {
    render(
      <NotetakerAccessSummary
        access={{ attendees: false, colleagues: { route: "SELECTED_PEOPLE", people: [] } }}
      />
    );

    expect(lines()).toEqual(["notetaker_access_hosts", "notetaker_access_selected_people_none"]);
  });
});
