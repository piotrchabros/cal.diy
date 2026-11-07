import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  default: vi.fn().mockResolvedValue({ client_id: "client-id", client_secret: "client-secret" }),
}));

vi.mock("../../../webex/lib/getWebexAppKeys", () => ({
  getWebexAppKeys: vi.fn().mockResolvedValue({ client_id: "client-id", client_secret: "client-secret" }),
}));

vi.mock("@calcom/prisma", () => ({
  default: { user: { findFirstOrThrow: vi.fn().mockResolvedValue({ id: 1 }) } },
}));

import webexAdd from "../../../webex/api/add";
import zohoBiginAdd from "../../../zoho-bigin/api/add";
import zohocalendarAdd from "../../../zohocalendar/api/add";
import zohocrmAdd from "../../../zohocrm/api/_getAdd";

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function buildReq(): NextApiRequest {
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
  res.json.mockReturnValue(res);
  return res;
}

async function getRedirectUri(handler: Handler): Promise<string | null> {
  const res = buildRes();
  await handler(buildReq(), res as unknown as NextApiResponse);
  expect(res.json).toHaveBeenCalledTimes(1);
  const { url } = res.json.mock.calls[0][0] as { url: string };
  return new URL(url).searchParams.get("redirect_uri");
}

const handlers: [string, Handler][] = [
  ["zohocrm", zohocrmAdd],
  ["zohocalendar", zohocalendarAdd],
  ["zoho-bigin", zohoBiginAdd],
  ["webex", webexAdd],
];

describe("org-aware redirect_uri in webex and zoho add handlers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(handlers)("%s uses the organization host when organizations are enabled", async (slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(await getRedirectUri(handler)).toBe(`https://acme.example.org/api/integrations/${slug}/callback`);
  });

  it.each(handlers)("%s uses the default app host when organizations are disabled", async (slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(await getRedirectUri(handler)).toBe(`https://app.example.com/api/integrations/${slug}/callback`);
  });
});
