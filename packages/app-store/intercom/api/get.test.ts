import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./get";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { team: { findFirst: vi.fn() } },
}));

vi.mock("@calcom/prisma", () => ({
  default: prismaMock,
  prisma: prismaMock,
}));

vi.mock("@calcom/lib/constants", () => ({
  WEBAPP_URL: "https://app.cal.com",
}));

const runHandler = async (url: string | undefined) => {
  const req = { method: "POST", query: { url } } as unknown as NextApiRequest;
  const send = vi.fn();
  const json = vi.fn();
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    send,
    json,
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { res, send, json };
};

describe("intercom embed get handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("embeds cal.com links without touching organization settings", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    const { res, send } = await runHandler("https://cal.com/alice/30min");

    expect(res.status).toHaveBeenCalledWith(200);
    expect(send.mock.calls[0][0]).toContain('origin: "https://cal.com"');
    expect(send.mock.calls[0][0]).toContain('calLink: "alice/30min"');
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });

  it("embeds links on a known organization custom domain", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue({ id: 9 });

    const { res, send } = await runHandler("https://cal.bespokesoft.pl/alice/30min");

    expect(prismaMock.team.findFirst).toHaveBeenCalledWith({
      where: {
        isOrganization: true,
        parentId: null,
        organizationSettings: { customDomain: "cal.bespokesoft.pl" },
      },
      select: { id: true },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(send.mock.calls[0][0]).toContain('origin: "https://cal.bespokesoft.pl"');
    expect(send.mock.calls[0][0]).toContain('calLink: "alice/30min"');
  });

  it("rejects unknown domains", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue(null);

    const { res, json } = await runHandler("https://evil.example.com/alice/30min");

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      message: "URL must be for cal.com, a subdomain of cal.com, or a known organization domain",
    });
  });

  it("rejects organization custom domains while organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    const { res } = await runHandler("https://cal.bespokesoft.pl/alice/30min");

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });
});
