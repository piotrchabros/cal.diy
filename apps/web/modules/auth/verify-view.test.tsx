import { signIn } from "next-auth/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendVerificationLogin } from "./verify-view";

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

vi.mock("@calcom/ui/components/toast", () => ({
  showToast: vi.fn(),
}));

const t = (key: string) => key;

describe("sendVerificationLogin", () => {
  beforeEach(() => {
    vi.mocked(signIn).mockReset();
    vi.mocked(signIn).mockResolvedValue(undefined);
  });

  it("uses the given base URL as the callback", async () => {
    await sendVerificationLogin("User@Acme.test", "User", t, "https://acme.test");

    expect(signIn).toHaveBeenCalledWith("email", {
      email: "user@acme.test",
      username: "user",
      redirect: false,
      callbackUrl: "https://acme.test",
    });
  });

  it("falls back to app.cal.com when the base URL is empty", async () => {
    await sendVerificationLogin("user@acme.test", "user", t, "");

    expect(signIn).toHaveBeenCalledWith(
      "email",
      expect.objectContaining({ callbackUrl: "https://app.cal.com" })
    );
  });
});
