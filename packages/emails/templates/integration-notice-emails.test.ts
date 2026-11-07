import { WEBAPP_URL } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import DisabledAppEmail from "./disabled-app-email";
import SlugReplacementEmail from "./slug-replacement-email";

const ORG_URL = "https://org.example.com";

const t = ((key: string) => key) as unknown as TFunction;

type EmailWithPayload = { getNodeMailerPayload(): Promise<Record<string, unknown>> };

const html = async (email: unknown) => {
  const payload = await (email as EmailWithPayload).getNodeMailerPayload();
  return String(payload.html);
};

describe("DisabledAppEmail links", () => {
  it.each([
    ["payment", ["payment"], "Paid call", 5, `${ORG_URL}/event-types/5?tabName=apps`],
    ["an event type", ["other"], "Intro", 6, `${ORG_URL}/event-types/6?tabName=apps`],
    ["video", ["video"], undefined, undefined, `${ORG_URL}/apps/installed`],
    ["calendar", ["calendar"], undefined, undefined, `${ORG_URL}/apps/installed`],
    ["any other app", ["other"], undefined, undefined, `${ORG_URL}/apps/installed`],
  ])("uses the recipient's base URL for %s", async (_label, appType, title, eventTypeId, expected) => {
    const email = new DisabledAppEmail("u@example.com", "App", appType, t, title, eventTypeId, ORG_URL);

    expect(await html(email)).toContain(expected);
  });

  it("falls back to WEBAPP_URL without a base URL", async () => {
    const email = new DisabledAppEmail("u@example.com", "App", ["video"], t);

    expect(await html(email)).toContain(`${WEBAPP_URL}/apps/installed`);
  });
});

describe("SlugReplacementEmail links", () => {
  it("uses the recipient's base URL", async () => {
    const email = new SlugReplacementEmail("u@example.com", "User", "Team", "intro", t, ORG_URL);

    expect(await html(email)).toContain(`${ORG_URL}/event-types`);
  });

  it("falls back to WEBAPP_URL without a base URL", async () => {
    const email = new SlugReplacementEmail("u@example.com", "User", null, "intro", t);

    expect(await html(email)).toContain(`${WEBAPP_URL}/event-types`);
  });
});
