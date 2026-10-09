import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { dispatchDue } = vi.hoisted(() => ({ dispatchDue: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerDispatchService.container", () => ({
  getNotetakerDispatchService: () => ({ dispatchDue }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

import { GET } from "../route";

const CRON_URL = "http://localhost/api/cron/notetaker";

function callGet(request: NextRequest) {
  return GET(request, { params: Promise.resolve({}) });
}

describe("/api/cron/notetaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDue.mockResolvedValue(undefined);
    vi.stubEnv("CRON_API_KEY", "test-cron-key");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("authorization", () => {
    test("accepts CRON_API_KEY in the authorization header", async () => {
      const request = new NextRequest(CRON_URL, { headers: { authorization: "test-cron-key" } });

      const response = await callGet(request);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(dispatchDue).toHaveBeenCalledOnce();
    });

    test("accepts Bearer CRON_SECRET in the authorization header", async () => {
      const request = new NextRequest(CRON_URL, { headers: { authorization: "Bearer test-cron-secret" } });

      const response = await callGet(request);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(dispatchDue).toHaveBeenCalledOnce();
    });

    test("accepts CRON_API_KEY in the apiKey query parameter", async () => {
      const request = new NextRequest(`${CRON_URL}?apiKey=test-cron-key`);

      const response = await callGet(request);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(dispatchDue).toHaveBeenCalledOnce();
    });

    test("returns 401 without credentials", async () => {
      const response = await callGet(new NextRequest(CRON_URL));

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    test("returns 401 for a wrong authorization header", async () => {
      const request = new NextRequest(CRON_URL, { headers: { authorization: "wrong-key" } });

      const response = await callGet(request);

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    test("returns 401 for a wrong apiKey query parameter", async () => {
      const response = await callGet(new NextRequest(`${CRON_URL}?apiKey=wrong-key`));

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    test("returns 401 for CRON_SECRET without the Bearer prefix", async () => {
      const request = new NextRequest(CRON_URL, { headers: { authorization: "test-cron-secret" } });

      const response = await callGet(request);

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    // The authorization header wins over the query parameter, so a bad header cannot be rescued by a good key.
    test("returns 401 when a wrong header accompanies a valid apiKey query parameter", async () => {
      const request = new NextRequest(`${CRON_URL}?apiKey=test-cron-key`, {
        headers: { authorization: "wrong-key" },
      });

      const response = await callGet(request);

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });
  });

  describe("authorization with unconfigured secrets", () => {
    test("returns 401 for 'Bearer undefined' when CRON_SECRET is unset", async () => {
      vi.stubEnv("CRON_SECRET", undefined);
      const request = new NextRequest(CRON_URL, { headers: { authorization: "Bearer undefined" } });

      const response = await callGet(request);

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    test("returns 401 without credentials when both env vars are unset", async () => {
      vi.stubEnv("CRON_API_KEY", undefined);
      vi.stubEnv("CRON_SECRET", undefined);

      const response = await callGet(new NextRequest(CRON_URL));

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    test("returns 401 for an 'undefined' apiKey query parameter when both env vars are unset", async () => {
      vi.stubEnv("CRON_API_KEY", undefined);
      vi.stubEnv("CRON_SECRET", undefined);

      const response = await callGet(new NextRequest(`${CRON_URL}?apiKey=undefined`));

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    test("returns 401 for an empty apiKey query parameter when CRON_API_KEY is empty", async () => {
      vi.stubEnv("CRON_API_KEY", "");

      const response = await callGet(new NextRequest(`${CRON_URL}?apiKey=`));

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    test("returns 401 for a bare 'Bearer ' apiKey query parameter when CRON_SECRET is empty", async () => {
      vi.stubEnv("CRON_SECRET", "");

      const response = await callGet(new NextRequest(`${CRON_URL}?apiKey=Bearer%20`));

      expect(response.status).toBe(401);
      expect(dispatchDue).not.toHaveBeenCalled();
    });

    test("still accepts CRON_API_KEY when CRON_SECRET is unset", async () => {
      vi.stubEnv("CRON_SECRET", undefined);
      const request = new NextRequest(CRON_URL, { headers: { authorization: "test-cron-key" } });

      const response = await callGet(request);

      expect(response.status).toBe(200);
      expect(dispatchDue).toHaveBeenCalledOnce();
    });

    test("still accepts Bearer CRON_SECRET when CRON_API_KEY is unset", async () => {
      vi.stubEnv("CRON_API_KEY", undefined);
      const request = new NextRequest(CRON_URL, { headers: { authorization: "Bearer test-cron-secret" } });

      const response = await callGet(request);

      expect(response.status).toBe(200);
      expect(dispatchDue).toHaveBeenCalledOnce();
    });
  });

  describe("failures", () => {
    test("returns 500 when dispatchDue rejects", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      dispatchDue.mockRejectedValue(new Error("dispatch failed"));
      const request = new NextRequest(CRON_URL, { headers: { authorization: "test-cron-key" } });

      const response = await callGet(request);

      expect(response.status).toBe(500);
      consoleError.mockRestore();
    });
  });
});
