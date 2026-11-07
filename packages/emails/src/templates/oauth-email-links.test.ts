import { WEBAPP_URL } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import renderEmail from "../renderEmail";

const ORG_URL = "https://acme.example.com";

const translate = ((key: string) => key) as unknown as TFunction;

const logoHrefs = (html: string) =>
  Array.from(
    html.matchAll(/<a href="([^"]*)" target="_blank" rel="noreferrer"><img height="19"/g),
    ([, href]) => href
  );

const renderClientEmails = (baseUrl?: string) =>
  Promise.all([
    renderEmail("OAuthClientApprovedNotificationEmail", {
      language: translate,
      userName: "Dev",
      clientName: "My App",
      clientId: "client-id",
      baseUrl,
    }),
    renderEmail("OAuthClientRejectedNotificationEmail", {
      language: translate,
      userName: "Dev",
      clientName: "My App",
      clientId: "client-id",
      rejectionReason: "Missing details",
      baseUrl,
    }),
  ]);

describe("OAuth client email links", () => {
  it.each([
    ["with baseUrl", ORG_URL, ORG_URL],
    ["without baseUrl", undefined, WEBAPP_URL],
  ])("links approved and rejected emails to the developer's organization (%s)", async (_, baseUrl, expected) => {
    for (const html of await renderClientEmails(baseUrl)) {
      expect(html).toContain(`href="${expected}/settings/developer/oauth"`);
      expect(logoHrefs(html)).toEqual([expected]);
      if (expected !== WEBAPP_URL) expect(html).not.toContain(`${WEBAPP_URL}/settings`);
    }
  });

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
    const orgAdmin = await renderEmail("AdminOrganizationNotificationEmail", {
      language: translate,
      orgSlug: "acme",
      webappIPAddress: "127.0.0.1",
    });
    expect(oauthAdmin).toContain(`href="${WEBAPP_URL}/settings/admin/oauth"`);
    expect(orgAdmin).toContain(`href="${WEBAPP_URL}/settings/admin/organizations"`);
    expect(logoHrefs(oauthAdmin)).toEqual([WEBAPP_URL]);
    expect(logoHrefs(orgAdmin)).toEqual([WEBAPP_URL]);
  });
});
