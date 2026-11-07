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
  default: vi.fn().mockResolvedValue({ client_id: "test-client-id", consumer_key: "test-consumer-key" }),
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: vi.fn().mockResolvedValue({ user: { id: 1 } }),
}));

vi.mock("@calcom/app-store/_utils/installation", () => ({
  createDefaultInstallation: vi.fn().mockResolvedValue(undefined),
}));

import hubspotAdd from "../../../hubspot/api/add";
import intercomAdd from "../../../intercom/api/add";
import pipedriveAdd from "../../../pipedrive-crm/api/add";
import salesforceAdd from "../../../salesforce/api/add";

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
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status } as unknown as NextApiResponse, status, json };
}

async function getRedirectUri(handler: Handler) {
  const { res, status, json } = buildRes();
  await handler(buildReq(), res);
  expect(status).toHaveBeenCalledWith(200);
  const { url } = json.mock.calls[0][0] as { url: string };
  return new URL(url).searchParams.get("redirect_uri");
}

const handlers: [string, Handler][] = [
  ["hubspot", hubspotAdd],
  ["intercom", intercomAdd],
  ["salesforce", salesforceAdd],
  ["pipedrive-crm", pipedriveAdd],
];

describe("OAuth add handlers redirect to the organization host", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(
    handlers
  )("%s uses the organization callback when organizations are enabled", async (slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(await getRedirectUri(handler)).toBe(`https://acme.example.org/api/integrations/${slug}/callback`);
  });

  it.each(handlers)("%s uses the default callback when organizations are disabled", async (slug, handler) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(await getRedirectUri(handler)).toBe(`https://app.example.com/api/integrations/${slug}/callback`);
  });
});
