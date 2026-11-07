import { WEBAPP_URL } from "@calcom/lib/constants";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { UserAvatarGroup } from "./UserAvatarGroup";

const users = [
  {
    name: "John Doe",
    username: "john",
    avatarUrl: null,
    profile: { id: 1, username: "john", organizationId: null, organization: null },
  },
];

describe("UserAvatarGroup", () => {
  test("links to the user's page on WEBAPP_URL by default", () => {
    render(<UserAvatarGroup size="sm" users={users} />);
    expect(screen.getByTestId("avatar-href").getAttribute("href")).toBe(`${WEBAPP_URL}/john?redirect=false`);
  });

  test("links to the user's page on the given baseUrl", () => {
    render(<UserAvatarGroup size="sm" users={users} baseUrl="https://acme.test" />);
    expect(screen.getByTestId("avatar-href").getAttribute("href")).toBe(
      "https://acme.test/john?redirect=false"
    );
  });
});
