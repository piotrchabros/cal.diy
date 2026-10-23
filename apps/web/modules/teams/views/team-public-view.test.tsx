import type { PublicTeamProfile } from "@calcom/features/teams/services/TeamProfileService";
import type { PublicTeamMemberDto } from "@calcom/lib/dto/PublicTeamMemberDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamPublicView } from "./team-public-view";

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/team/bluebee",
}));

vi.mock("@calcom/web/modules/event-types/components/EmptyPage", () => ({
  default: ({ name }: { name: string }) => <div data-testid="empty-page">{name}</div>,
}));

const team = {
  id: 1,
  name: "BlueBee",
  slug: "bluebee",
  bio: null,
  logoUrl: null,
  location: null,
  socialLinks: [],
  hideBookATeamMember: false,
  eventTypes: [{ id: 10, title: "Team call", slug: "team-call", description: null, length: 30 }],
} as unknown as PublicTeamProfile;

const members: PublicTeamMemberDto[] = [
  {
    username: "anna",
    name: "Anna",
    avatarUrl: "",
    eventTypes: [{ id: 20, title: "Anna intro", slug: "intro", description: null, length: 15 }],
  },
  { username: "jan", name: "Jan", avatarUrl: "", eventTypes: [] },
];

describe("TeamPublicView", () => {
  const replaceState = vi.spyOn(window.history, "replaceState");

  beforeEach(() => {
    replaceState.mockClear();
  });

  afterEach(() => {
    replaceState.mockReset();
  });

  it("renders without tabs when there are no members", () => {
    render(<TeamPublicView team={team} members={[]} initialMemberUsername={null} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("book-event-10").getAttribute("href")).toBe("/team/bluebee/team-call");
  });

  it("renders EmptyPage when there are no members and no events", () => {
    render(<TeamPublicView team={{ ...team, eventTypes: [] }} members={[]} initialMemberUsername={null} />);
    expect(screen.getByTestId("empty-page")).toBeTruthy();
  });

  it("switches between whole team and member tabs", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername={null} />);
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.getByTestId("book-event-10")).toBeTruthy();

    fireEvent.click(screen.getByTestId("team-tab-anna"));
    expect(screen.getByTestId("book-event-20").getAttribute("href")).toBe("/anna/intro");
    expect(screen.getByTestId("member-profile-link").getAttribute("href")).toBe("/anna");
    expect(screen.queryByTestId("book-event-10")).toBeNull();

    fireEvent.click(screen.getByTestId("team-tab-whole-team"));
    expect(screen.getByTestId("book-event-10")).toBeTruthy();
  });

  it("selects the initial member", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername="anna" />);
    expect(screen.getByTestId("team-tab-anna").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("book-event-20")).toBeTruthy();
  });

  it("falls back to whole team for an unknown member", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername="nobody" />);
    expect(screen.getByTestId("team-tab-whole-team").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("book-event-10")).toBeTruthy();
  });

  it("shows the no team event types text when only members have events", () => {
    render(
      <TeamPublicView team={{ ...team, eventTypes: [] }} members={members} initialMemberUsername={null} />
    );
    expect(screen.getByTestId("team-no-event-types")).toBeTruthy();
    expect(screen.queryByTestId("empty-page")).toBeNull();
  });

  it("updates the url search when selecting a tab", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername={null} />);
    fireEvent.click(screen.getByTestId("team-tab-jan"));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/team/bluebee?member=jan");
    fireEvent.click(screen.getByTestId("team-tab-whole-team"));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/team/bluebee");
  });
});
