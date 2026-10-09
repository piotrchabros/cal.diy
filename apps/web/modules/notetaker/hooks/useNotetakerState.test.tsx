import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSummaryStatusDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTETAKER_STATE_POLL_INTERVAL_MS, useNotetakerState } from "./useNotetakerState";

type FakeQuery = {
  state: {
    status: "pending" | "success" | "error";
    data:
      | {
          status: NotetakerSessionStatusDto | null;
          summary: { status: NotetakerSummaryStatusDto } | null;
        }
      | undefined;
  };
};
type QueryOptions = { retry: boolean; refetchInterval: (query: FakeQuery) => number | false };
type QueryResult = { data: undefined; isPending: boolean };

const BOOKING_UID = "booking-uid-1";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<(input: { bookingUid: string }, options: QueryOptions) => QueryResult>(),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: { viewer: { notetaker: { getState: { useQuery: mocks.useQuery } } } },
}));

const queryResult: QueryResult = { data: undefined, isPending: true };

function getOptions(): QueryOptions {
  const options = mocks.useQuery.mock.calls[0]?.[1];
  if (!options) throw new Error("useQuery was not called with options");
  return options;
}

function buildQuery(
  status: NotetakerSessionStatusDto | null,
  summaryStatus: NotetakerSummaryStatusDto | null = null,
  queryStatus: FakeQuery["state"]["status"] = "success"
): FakeQuery {
  return {
    state: {
      status: queryStatus,
      data: { status, summary: summaryStatus ? { status: summaryStatus } : null },
    },
  };
}

function getRefetchInterval(query: FakeQuery): number | false {
  renderHook(() => useNotetakerState(BOOKING_UID));
  return getOptions().refetchInterval(query);
}

describe("useNotetakerState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useQuery.mockReturnValue(queryResult);
  });

  it("passes the booking uid", () => {
    const { result } = renderHook(() => useNotetakerState(BOOKING_UID));

    expect(mocks.useQuery).toHaveBeenCalledTimes(1);
    expect(mocks.useQuery.mock.calls[0]?.[0]).toEqual({ bookingUid: BOOKING_UID });
    expect(getOptions().retry).toBe(false);
    expect(result.current).toBe(queryResult);
  });

  it.each<NotetakerSessionStatusDto>([
    "SCHEDULED",
    "WAITING_TO_BE_ADMITTED",
    "TRANSCRIBING",
    "PROCESSING",
  ])("polls while the status is %s", (status) => {
    expect(getRefetchInterval(buildQuery(status))).toBe(NOTETAKER_STATE_POLL_INTERVAL_MS);
  });

  it.each<NotetakerSessionStatusDto>(["READY", "ENDED_EARLY", "FAILED"])("stops polling on %s", (status) => {
    expect(getRefetchInterval(buildQuery(status))).toBe(false);
  });

  it("stops polling on READY when the summary is READY", () => {
    expect(getRefetchInterval(buildQuery("READY", "READY"))).toBe(false);
  });

  it("stops polling when the status is null", () => {
    expect(getRefetchInterval(buildQuery(null))).toBe(false);
  });

  it("stops polling when there is no data", () => {
    expect(getRefetchInterval({ state: { status: "pending", data: undefined } })).toBe(false);
  });

  it("keeps polling while the summary is PENDING after the session is READY", () => {
    expect(getRefetchInterval(buildQuery("READY", "PENDING"))).toBe(NOTETAKER_STATE_POLL_INTERVAL_MS);
  });

  it("stops polling after a query error even when the last data is live", () => {
    expect(getRefetchInterval(buildQuery("TRANSCRIBING", null, "error"))).toBe(false);
  });

  it("exports a five second interval", () => {
    expect(NOTETAKER_STATE_POLL_INTERVAL_MS).toBe(5000);
  });
});
