import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constants = vi.hoisted(() => ({
  WEBAPP_URL: "https://app.example.com",
  WEBAPP_URL_FOR_OAUTH: "https://app.example.com",
  ALLOWED_HOSTNAMES: ["acme.example.org"] as string[],
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  ...constants,
}));

vi.mock("../../getAppKeysFromSlug", () => ({
  default: vi.fn().mockResolvedValue({
    client_id: "client-id",
    client_secret: "client-secret",
    app_id: "app-id",
    app_secret: "app-secret",
    user_agent: "cal-test",
  }),
}));

vi.mock("@calcom/prisma", () => ({
  default: { user: { findFirstOrThrow: vi.fn().mockResolvedValue({ id: 1 }) } },
}));

import basecampAdd from "../../../basecamp3/api/add";
import closecomAdd from "../../../closecom/api/_getAdd";
import feishuAdd from "../../../feishucalendar/api/add";
import larkAdd from "../../../larkcalendar/api/add";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

function buildReq() {
  return {
    method: "GET",
    headers: { host: "acme.example.org" },
    query: {},
    session: { user: { id: 1 } },
  } as unknown as NextApiRequest;
}

function buildRes() {
  const res = {
    writableEnded: false,
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockImplementation(() => {
    res.writableEnded = true;
    return res;
  });
  return res;
}

async function getRedirectUri(handler: Handler) {
  const res = buildRes();
  await handler(buildReq(), res as unknown as NextApiResponse);
  expect(res.json).toHaveBeenCalledTimes(1);
  const { url } = res.json.mock.calls[0][0] as { url: string };
  return new URL(url).searchParams.get("redirect_uri");
}

const handlers: [string, Handler][] = [
  ["basecamp3", basecampAdd],
  ["closecom", closecomAdd],
  ["feishucalendar", feishuAdd],
  ["larkcalendar", larkAdd],
];

describe("OAuth add handlers use the organization callback host", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(
    handlers
  )("%s redirects to the organization host when organizations are enabled", async (slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(await getRedirectUri(handler)).toBe(`https://acme.example.org/api/integrations/${slug}/callback`);
  });

  it.each(
    handlers
  )("%s redirects to the default host when organizations are disabled", async (slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(await getRedirectUri(handler)).toBe(`https://app.example.com/api/integrations/${slug}/callback`);
  });
});
