import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constants = vi.hoisted(() => ({
  WEBAPP_URL: "https://app.example.com",
  WEBAPP_URL_FOR_OAUTH: "https://app.example.com",
  ALLOWED_HOSTNAMES: ["acme.example.org"] as string[],
}));

const { mockGetAppKeysFromSlug, mockFindFirstOrThrow } = vi.hoisted(() => ({
  mockGetAppKeysFromSlug: vi.fn(),
  mockFindFirstOrThrow: vi.fn(),
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  ...constants,
}));

vi.mock("../../getAppKeysFromSlug", () => ({ default: mockGetAppKeysFromSlug }));

vi.mock("@calcom/prisma", () => ({
  default: { user: { findFirstOrThrow: mockFindFirstOrThrow } },
}));

import huddle01videoAdd from "../../../huddle01video/api/add";
import jellyAdd from "../../../jelly/api/add";
import nextcloudtalkAdd from "../../../nextcloudtalk/api/add";
import tandemvideoAdd from "../../../tandemvideo/api/add";

type AddHandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const APP_KEYS = {
  client_id: "client-id",
  client_secret: "client-secret",
  base_url: "https://tandem.example.com",
  nextcloudTalkHost: "https://cloud.example.com",
  nextcloudTalkClientId: "client-id",
  nextcloudTalkClientSecret: "client-secret",
};

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
    setHeader: vi.fn(),
    json: vi.fn(),
    status: vi.fn(),
  };
  res.json.mockReturnValue(res);
  res.status.mockReturnValue(res);
  return res;
}

async function getRedirectUri(handler: AddHandler) {
  const res = buildRes();
  await handler(buildReq(), res as unknown as NextApiResponse);

  expect(res.json).toHaveBeenCalledTimes(1);
  const { url } = res.json.mock.calls[0][0] as { url: string };
  return new URL(url).searchParams.get("redirect_uri");
}

const handlers: [string, AddHandler][] = [
  ["huddle01video", huddle01videoAdd],
  ["nextcloudtalk", nextcloudtalkAdd],
  ["jelly", jellyAdd],
  ["tandemvideo", tandemvideoAdd],
];

describe("video app add handlers use the organization OAuth callback", () => {
  beforeEach(() => {
    mockGetAppKeysFromSlug.mockResolvedValue(APP_KEYS);
    mockFindFirstOrThrow.mockResolvedValue({ id: 1 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(handlers)("%s uses the request host when organizations are enabled", async (slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(await getRedirectUri(handler)).toBe(`https://acme.example.org/api/integrations/${slug}/callback`);
  });

  it.each(handlers)("%s uses the default callback when organizations are disabled", async (slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(await getRedirectUri(handler)).toBe(`https://app.example.com/api/integrations/${slug}/callback`);
  });
});
