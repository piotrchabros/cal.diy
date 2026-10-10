import type { NotetakerSharedResultsDto } from "@calcom/lib/dto/NotetakerSharedResultDto";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotetakerSharedResults } from "./useNotetakerSharedResults";

type QueryOptions = {
  retry: boolean;
  getNextPageParam: (last: NotetakerSharedResultsDto) => string | undefined;
};

const mocks = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn<(input: { limit: number }, options: QueryOptions) => { data: undefined }>(),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: { viewer: { notetaker: { listSharedWithMe: { useInfiniteQuery: mocks.useInfiniteQuery } } } },
}));

function getOptions(): QueryOptions {
  const options = mocks.useInfiniteQuery.mock.calls[0]?.[1];
  if (!options) throw new Error("useInfiniteQuery was not called with options");
  return options;
}

describe("useNotetakerSharedResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useInfiniteQuery.mockReturnValue({ data: undefined });
  });

  it("requests pages of 20 without retrying", () => {
    renderHook(() => useNotetakerSharedResults());

    expect(mocks.useInfiniteQuery).toHaveBeenCalledWith(
      { limit: 20 },
      expect.objectContaining({ retry: false })
    );
  });

  it("continues from the next cursor and stops when there is none", () => {
    renderHook(() => useNotetakerSharedResults());
    const { getNextPageParam } = getOptions();

    expect(getNextPageParam({ items: [], nextCursor: "cursor-1" })).toBe("cursor-1");
    expect(getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
  });
});
