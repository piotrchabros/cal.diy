import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListUsers = vi.fn();

vi.mock("@calcom/features/di/containers/UserRepository", () => ({
  getUserRepository: () => ({ listUsers: mockListUsers }),
}));

import type { TrpcSessionUser } from "../../../types";
import listPaginatedHandler from "./listPaginated.handler";

const ctx = { user: { id: 1 } as NonNullable<TrpcSessionUser> };

describe("listPaginatedHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListUsers.mockResolvedValue({ users: [{ id: 3 }], total: 12, nextCursor: 3 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores the organization filter when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await listPaginatedHandler({ ctx, input: { limit: 10, organizationId: 7 } });

    expect(mockListUsers).toHaveBeenCalledWith(expect.objectContaining({ organizationId: null }));
  });

  it("passes the organization filter when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await listPaginatedHandler({ ctx, input: { limit: 10, cursor: 2, searchTerm: "a", organizationId: 7 } });

    expect(mockListUsers).toHaveBeenCalledWith({ limit: 10, cursor: 2, searchTerm: "a", organizationId: 7 });
  });

  it("passes null when organizations are enabled but no filter is given", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await listPaginatedHandler({ ctx, input: { limit: 10 } });

    expect(mockListUsers).toHaveBeenCalledWith(expect.objectContaining({ organizationId: null }));
  });

  it("maps the repository result to rows, nextCursor and totalRowCount", async () => {
    const result = await listPaginatedHandler({ ctx, input: { limit: 10 } });

    expect(result).toEqual({ rows: [{ id: 3 }], nextCursor: 3, meta: { totalRowCount: 12 } });
  });
});
