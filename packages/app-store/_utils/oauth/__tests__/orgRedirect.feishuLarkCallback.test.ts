import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constants = vi.hoisted(() => ({
  WEBAPP_URL: "https://app.example.com",
  WEBAPP_URL_FOR_OAUTH: "https://app.example.com",
  ALLOWED_HOSTNAMES: ["acme.example.org"] as string[],
}));

const mocks = vi.hoisted(() => ({
  decodeOAuthState: vi.fn(),
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  ...constants,
}));

vi.mock("../decodeOAuthState", () => ({
  decodeOAuthState: mocks.decodeOAuthState,
}));

vi.mock("../../../feishucalendar/lib/AppAccessToken", () => ({
  getAppAccessToken: vi.fn().mockRejectedValue(new Error("token failure")),
}));

vi.mock("../../../larkcalendar/lib/AppAccessToken", () => ({
  getAppAccessToken: vi.fn().mockRejectedValue(new Error("token failure")),
}));

vi.mock("@calcom/prisma", () => ({ default: {} }));

import feishuCallback from "../../../feishucalendar/api/callback";
import larkCallback from "../../../larkcalendar/api/callback";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

function buildReq() {
  return {
    method: "GET",
    headers: { host: "acme.example.org" },
    query: { code: "auth-code" },
    session: { user: { id: 1 } },
  } as unknown as NextApiRequest;
}

async function getErrorRedirect(handler: Handler, returnTo?: string) {
  mocks.decodeOAuthState.mockReturnValue(returnTo === undefined ? undefined : { returnTo });
  const res = { redirect: vi.fn(), status: vi.fn(), json: vi.fn() };
  await handler(buildReq(), res as unknown as NextApiResponse);
  expect(res.redirect).toHaveBeenCalledTimes(1);
  return res.redirect.mock.calls[0][0];
}

const handlers: [string, Handler][] = [
  ["feishucalendar", feishuCallback],
  ["larkcalendar", larkCallback],
];

describe("Feishu/Lark callback error path validates returnTo", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(handlers)("%s keeps a returnTo on the organization host", async (_slug, handler) => {
    expect(await getErrorRedirect(handler, "https://acme.example.org/apps/installed/calendar")).toBe(
      "https://acme.example.org/apps/installed/calendar"
    );
  });

  it.each(handlers)("%s replaces a foreign returnTo with the organization origin", async (_slug, handler) => {
    expect(await getErrorRedirect(handler, "https://evil.example.com/x")).toBe("https://acme.example.org/");
  });

  it.each(
    handlers
  )("%s falls back to the default origin when organizations are disabled", async (_slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(await getErrorRedirect(handler, "https://evil.example.com/x")).toBe("https://app.example.com/");
  });

  it.each(handlers)("%s redirects to /apps/installed without a returnTo", async (_slug, handler) => {
    expect(await getErrorRedirect(handler)).toBe("/apps/installed");
  });

  it.each(handlers)("%s redirects to /apps/installed for a relative returnTo", async (_slug, handler) => {
    expect(await getErrorRedirect(handler, "/foo")).toBe("/apps/installed");
  });
});
