import type { NextApiRequest } from "next";
import { createMocks } from "node-mocks-http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, isSessionInRequestOrganizationMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  isSessionInRequestOrganizationMock: vi.fn(),
}));

vi.mock("./getSession", () => ({ getSession: getSessionMock }));
vi.mock("./isSessionInRequestOrganization", () => ({
  isSessionInRequestOrganization: isSessionInRequestOrganizationMock,
}));

import { HttpError } from "@calcom/lib/http-error";
import { ensureSession } from "./ensureSession";

function createMockRequest(): NextApiRequest {
  const { req } = createMocks<NextApiRequest>({ method: "GET" });
  return req;
}

const session = { user: { id: 42 }, expires: "2099-01-01T00:00:00.000Z" };

describe("ensureSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSessionInRequestOrganizationMock.mockResolvedValue(true);
  });

  it("throws 401 without running the organization check when there is no session", async () => {
    getSessionMock.mockResolvedValue(null);

    await expect(ensureSession({ req: createMockRequest() })).rejects.toMatchObject({ statusCode: 401 });
    expect(isSessionInRequestOrganizationMock).not.toHaveBeenCalled();
  });

  it("returns the session for the { req } shape", async () => {
    const req = createMockRequest();
    getSessionMock.mockResolvedValue(session);

    await expect(ensureSession({ req })).resolves.toBe(session);
    expect(isSessionInRequestOrganizationMock).toHaveBeenCalledWith({ userId: 42, headers: req.headers });
  });

  it("returns the session for the { ctx: { req } } shape", async () => {
    const req = createMockRequest();
    getSessionMock.mockResolvedValue(session);

    await expect(ensureSession({ ctx: { req } })).resolves.toBe(session);
    expect(isSessionInRequestOrganizationMock).toHaveBeenCalledWith({ userId: 42, headers: req.headers });
  });

  it("throws 401 when the session is outside the request organization", async () => {
    getSessionMock.mockResolvedValue(session);
    isSessionInRequestOrganizationMock.mockResolvedValue(false);

    const error = await ensureSession({ req: createMockRequest() }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ statusCode: 401 });
  });
});
