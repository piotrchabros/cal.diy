import type { PublicTeamProfile } from "@calcom/features/teams/services/TeamProfileService";
import type { PublicTeamMemberDto } from "@calcom/lib/dto/PublicTeamMemberDto";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
  const pushState = vi.spyOn(window.history, "pushState");

  beforeEach(() => {
    pushState.mockClear();
  });

  afterEach(() => {
    pushState.mockReset();
  });

  it("renders the team event list without tiles when there are no members", () => {
    render(<TeamPublicView team={team} members={[]} initialMemberUsername={null} initialView={null} />);
    expect(screen.queryByTestId("team-member-tiles")).toBeNull();
    expect(screen.getByTestId("book-event-10").getAttribute("href")).toBe("/team/bluebee/team-call");
  });

  it("renders EmptyPage when there are no members and no events", () => {
    render(
      <TeamPublicView
        team={{ ...team, eventTypes: [] }}
        members={[]}
        initialMemberUsername={null}
        initialView={null}
      />
    );
    expect(screen.getByTestId("empty-page")).toBeTruthy();
  });

  it("starts with a tile for the team and one per member", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername={null} initialView={null} />);
    expect(screen.getByTestId("team-tile-whole-team").textContent).toContain("BlueBee");
    expect(screen.getByTestId("team-tile-anna")).toBeTruthy();
    expect(screen.getByTestId("team-tile-jan")).toBeTruthy();
    expect(screen.queryByTestId("book-event-10")).toBeNull();
  });

  it("opens the team events from its tile and goes back to the tiles", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername={null} initialView={null} />);
    fireEvent.click(screen.getByTestId("team-tile-whole-team"));
    expect(screen.getByTestId("book-event-10").getAttribute("href")).toBe("/team/bluebee/team-call");
    expect(screen.queryByTestId("team-member-tiles")).toBeNull();
    expect(pushState).toHaveBeenLastCalledWith(null, "", "/team/bluebee?view=team");

    fireEvent.click(screen.getByTestId("team-page-back"));
    expect(screen.getByTestId("team-member-tiles")).toBeTruthy();
    expect(pushState).toHaveBeenLastCalledWith(null, "", "/team/bluebee");
  });

  it("opens a member's events from their tile", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername={null} initialView={null} />);
    fireEvent.click(screen.getByTestId("team-tile-anna"));
    expect(screen.getByTestId("book-event-20").getAttribute("href")).toBe("/anna/intro");
    expect(screen.getByTestId("member-profile-link").getAttribute("href")).toBe("/anna");
    expect(screen.queryByTestId("book-event-10")).toBeNull();
    expect(pushState).toHaveBeenLastCalledWith(null, "", "/team/bluebee?member=anna");
  });

  it("tells when a member has no event types", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername="jan" initialView={null} />);
    expect(screen.getByTestId("member-no-event-types")).toBeTruthy();
  });

  it("restores the selection from the url", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername="anna" initialView={null} />);
    expect(screen.getByTestId("book-event-20")).toBeTruthy();
  });

  it("falls back to the tiles for an unknown member", () => {
    render(
      <TeamPublicView team={team} members={members} initialMemberUsername="nobody" initialView={null} />
    );
    expect(screen.getByTestId("team-member-tiles")).toBeTruthy();
  });

  it("shows the no team event types text when the team has no events", () => {
    render(
      <TeamPublicView
        team={{ ...team, eventTypes: [] }}
        members={members}
        initialMemberUsername={null}
        initialView="team"
      />
    );
    expect(screen.getByTestId("team-no-event-types")).toBeTruthy();
    expect(screen.queryByTestId("empty-page")).toBeNull();
  });

  it("follows the browser back button", () => {
    render(<TeamPublicView team={team} members={members} initialMemberUsername="anna" initialView={null} />);
    act(() => {
      window.history.replaceState(null, "", "/team/bluebee");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByTestId("team-member-tiles")).toBeTruthy();
  });
});
