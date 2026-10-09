import { createNextApiHandler } from "@calcom/trpc/server/createNextApiHandler";
import { notetakerRouter } from "@calcom/trpc/server/routers/viewer/notetaker/_router";
import { describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "./shared";

vi.mock("@calcom/trpc/server/createNextApiHandler", () => ({
  createNextApiHandler: vi.fn(() => vi.fn()),
}));

vi.mock("@calcom/trpc/server/routers/viewer/notetaker/_router", () => ({
  notetakerRouter: {},
}));

// The client's resolveEndpoint is not exported (apps/web/app/_trpc/trpc-client.ts,
// packages/trpc/react/trpc.ts), so this mirrors its three-segment branch.
const endpointFor = (path: string): string | undefined => path.split(".")[1];

describe("trpc client endpoints for notetaker", () => {
  it("registers the endpoint the client resolves for viewer.notetaker.* procedures", () => {
    expect(ENDPOINTS).toContain(endpointFor("viewer.notetaker.getState"));
  });

  it("serves the notetaker endpoint through an authenticated-only API handler", async () => {
    // Specifier is built in a variable so a missing file fails only this test, not type-checking.
    const specifier: string = "../../../apps/web/pages/api/trpc/notetaker/[trpc]";
    const mod = await import(/* @vite-ignore */ specifier);

    expect(typeof mod.default).toBe("function");
    expect(vi.mocked(createNextApiHandler)).toHaveBeenCalledWith(notetakerRouter);
    expect(vi.mocked(createNextApiHandler).mock.calls[0]).toHaveLength(1);
  });
});
