import { WEBAPP_URL } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import renderEmail from "../renderEmail";

const translate = ((key: string) => key) as unknown as TFunction;

const logoHrefs = (html: string) =>
  Array.from(
    html.matchAll(/<a href="([^"]*)" target="_blank" rel="noreferrer"><img height="19"/g),
    ([, href]) => href
  );

describe("OAuth client email links", () => {
  // Admin notifications go to instance admins, whose /settings/admin pages live on the default organization.
  it("keeps WEBAPP_URL in admin notification emails", async () => {
    const oauthAdmin = await renderEmail("AdminOAuthClientNotificationEmail", {
      language: translate,
      clientName: "My App",
      purpose: null,
      clientId: "client-id",
      redirectUri: "https://app.example.com/callback",
      submitterEmail: "dev@example.com",
      submitterName: "Dev",
    });
    expect(oauthAdmin).toContain(`href="${WEBAPP_URL}/settings/admin/oauth"`);
    expect(logoHrefs(oauthAdmin)).toEqual([WEBAPP_URL]);
  });
});
