import type { BookerEvent } from "@calcom/features/bookings/types";
import { OrgBaseUrlContext } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { SchedulingType } from "@calcom/prisma/enums";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventMembers } from "./Members";

vi.mock("@calcom/features/bookings/Booker/store", () => ({
  useBookerStore: (selector: (state: { username: string | null }) => unknown) =>
    selector({ username: "jane" }),
}));
vi.mock("@calcom/embed-core/embed-iframe", () => ({ useIsEmbed: () => false }));
vi.mock("@calcom/atoms/hooks/useIsPlatform", () => ({ useIsPlatform: () => false }));

const users = [
  { name: "Jane", username: "jane", avatarUrl: "https://img.test/jane.png", profile: { username: "jane" } },
] as unknown as BookerEvent["subsetOfUsers"];

const renderMembers = () =>
  render(
    <OrgBaseUrlContext.Provider value={{ baseUrl: "https://acme.test", orgSlug: "acme" }}>
      <EventMembers
        schedulingType={SchedulingType.COLLECTIVE}
        users={users}
        profile={{ name: "Jane" } as BookerEvent["profile"]}
        entity={{ teamSlug: null, hideProfileLink: false } as unknown as BookerEvent["entity"]}
        isPrivateLink={false}
      />
    </OrgBaseUrlContext.Provider>
  );

describe("EventMembers", () => {
  it("links members to their profile on the organization base URL", () => {
    const { container } = renderMembers();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://acme.test/jane?redirect=false");
  });
});
