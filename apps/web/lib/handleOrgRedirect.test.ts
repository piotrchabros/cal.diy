import type { ParsedUrlQuery } from "node:querystring";
import type { RedirectTypeDto } from "@calcom/features/organizations/repositories/interfaces/ITempOrgRedirectRepository";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRedirectWithOriginAndSearchString,
  handleOrgRedirect,
  NON_ORG_REDIRECT_FROM_ORG_ID,
  type OrgRedirect,
  omitRouteParams,
} from "./handleOrgRedirect";

const repoMock = vi.hoisted(() => ({
  findEnabledByFromSlugs: vi.fn(),
}));

vi.mock("@calcom/features/organizations/di/TempOrgRedirectRepository.container", () => ({
  getTempOrgRedirectRepository: () => repoMock,
}));

const createTestRedirectParams = (overrides?: {
  slugs?: string[];
  redirectType?: RedirectTypeDto;
  eventTypeSlug?: string | null;
  query?: ParsedUrlQuery;
  hostOrgId?: number | null;
}) => ({
  slugs: overrides?.slugs ?? ["john87"],
  redirectType: overrides?.redirectType ?? "User",
  eventTypeSlug: overrides?.eventTypeSlug ?? null,
  query: overrides?.query ?? {},
  hostOrgId: overrides?.hostOrgId === undefined ? null : overrides.hostOrgId,
});

const createRedirectScenario = (redirects: Array<{ from: string; toUrl: string }>) => {
  const toUrlBySlug = new Map(redirects.map((redirect) => [redirect.from, redirect.toUrl]));
  repoMock.findEnabledByFromSlugs.mockImplementation(async ({ fromSlugs }: { fromSlugs: string[] }) =>
    fromSlugs.flatMap((slug) => {
      const toUrl = toUrlBySlug.get(slug);
      return toUrl ? [{ from: slug, toUrl }] : [];
    })
  );
};

const expectRedirectTo = (result: OrgRedirect | null, expectedDestination: string) => {
  expect(result).toEqual({ redirect: { permanent: true, destination: expectedDestination } });
};

describe("handleOrgRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRedirectScenario([]);
  });

  describe("repository lookup", () => {
    it("queries the host organization's redirects", async () => {
      createRedirectScenario([{ from: "john87", toUrl: "https://cal.bespokesoft.pl/john" }]);

      await handleOrgRedirect(createTestRedirectParams({ hostOrgId: 7 }));

      expect(repoMock.findEnabledByFromSlugs).toHaveBeenCalledWith({
        fromOrgId: 7,
        type: "User",
        fromSlugs: ["john87"],
      });
    });

    it("queries non-org redirects when organizations are disabled", async () => {
      await handleOrgRedirect(createTestRedirectParams({ hostOrgId: null }));

      expect(repoMock.findEnabledByFromSlugs).toHaveBeenCalledWith({
        fromOrgId: NON_ORG_REDIRECT_FROM_ORG_ID,
        type: "User",
        fromSlugs: ["john87"],
      });
      expect(NON_ORG_REDIRECT_FROM_ORG_ID).toBe(0);
    });

    it("returns null when no redirect exists", async () => {
      expect(await handleOrgRedirect(createTestRedirectParams())).toBeNull();
    });

    it("returns null for empty slugs without querying", async () => {
      expect(await handleOrgRedirect(createTestRedirectParams({ slugs: [] }))).toBeNull();
      expect(repoMock.findEnabledByFromSlugs).not.toHaveBeenCalled();
    });
  });

  describe("destination", () => {
    it("redirects to the exact toUrl", async () => {
      createRedirectScenario([{ from: "john87", toUrl: "https://cal.bespokesoft.pl/john" }]);

      const result = await handleOrgRedirect(createTestRedirectParams());

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john");
    });

    it("appends the event type slug", async () => {
      createRedirectScenario([{ from: "john87", toUrl: "https://cal.bespokesoft.pl/john" }]);

      const result = await handleOrgRedirect(createTestRedirectParams({ eventTypeSlug: "30min" }));

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john/30min");
    });

    it("handles Team redirects", async () => {
      createRedirectScenario([{ from: "acme-sales", toUrl: "https://new.domain/team/newslug" }]);

      const result = await handleOrgRedirect(
        createTestRedirectParams({ slugs: ["acme-sales"], redirectType: "Team", eventTypeSlug: "intro" })
      );

      expect(repoMock.findEnabledByFromSlugs).toHaveBeenCalledWith(
        expect.objectContaining({ type: "Team", fromSlugs: ["acme-sales"] })
      );
      expectRedirectTo(result, "https://new.domain/team/newslug/intro");
    });

    it("strips trailing slashes from the toUrl path", async () => {
      createRedirectScenario([{ from: "john87", toUrl: "https://cal.bespokesoft.pl/john/" }]);

      const result = await handleOrgRedirect(createTestRedirectParams({ eventTypeSlug: "30min" }));

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john/30min");
    });

    it("handles a root toUrl", async () => {
      createRedirectScenario([{ from: "john87", toUrl: "https://x/" }]);

      expectRedirectTo(await handleOrgRedirect(createTestRedirectParams()), "https://x/");
      expectRedirectTo(
        await handleOrgRedirect(createTestRedirectParams({ eventTypeSlug: "30min" })),
        "https://x/30min"
      );
    });

    it("ignores the toUrl search and hash", async () => {
      createRedirectScenario([{ from: "john87", toUrl: "https://cal.bespokesoft.pl/john?a=b#h" }]);

      const result = await handleOrgRedirect(createTestRedirectParams());

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john");
    });

    it("returns null for an invalid toUrl", async () => {
      createRedirectScenario([{ from: "john87", toUrl: "not a url" }]);

      expect(await handleOrgRedirect(createTestRedirectParams())).toBeNull();
    });

    it("encodes special characters in the event type slug", async () => {
      createRedirectScenario([{ from: "john87", toUrl: "https://cal.bespokesoft.pl/john" }]);

      const result = await handleOrgRedirect(createTestRedirectParams({ eventTypeSlug: "a b/c?" }));

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john/a%20b%2Fc%3F");
    });
  });

  describe("when handling multiple slugs (group bookings)", () => {
    it("joins paths in input order even when the repository returns them out of order", async () => {
      repoMock.findEnabledByFromSlugs.mockResolvedValue([
        { from: "bob1", toUrl: "https://acme.example/bob" },
        { from: "alice1", toUrl: "https://acme.example/alice" },
      ]);

      const result = await handleOrgRedirect(
        createTestRedirectParams({ slugs: ["alice1", "bob1"], eventTypeSlug: "30min" })
      );

      expectRedirectTo(result, "https://acme.example/alice+bob/30min");
    });

    it("returns null when only some slugs have redirects", async () => {
      createRedirectScenario([{ from: "alice1", toUrl: "https://acme.example/alice" }]);

      expect(await handleOrgRedirect(createTestRedirectParams({ slugs: ["alice1", "bob1"] }))).toBeNull();
    });

    it("returns null when redirects point to different origins", async () => {
      createRedirectScenario([
        { from: "alice1", toUrl: "https://acme.example/alice" },
        { from: "bob1", toUrl: "https://other.example/bob" },
      ]);

      expect(await handleOrgRedirect(createTestRedirectParams({ slugs: ["alice1", "bob1"] }))).toBeNull();
    });

    it("returns null when a target path has several segments", async () => {
      createRedirectScenario([
        { from: "alice1", toUrl: "https://acme.example/alice" },
        { from: "bob1", toUrl: "https://acme.example/team/bob" },
      ]);

      expect(await handleOrgRedirect(createTestRedirectParams({ slugs: ["alice1", "bob1"] }))).toBeNull();
    });
  });

  describe("when handling query parameters", () => {
    beforeEach(() => {
      createRedirectScenario([{ from: "john87", toUrl: "https://cal.bespokesoft.pl/john" }]);
    });

    it("preserves existing query parameters", async () => {
      const result = await handleOrgRedirect(
        createTestRedirectParams({ query: { month: "2026-11", layout: "week_view" } })
      );

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john?month=2026-11&layout=week_view");
    });

    it("repeats keys for array values", async () => {
      const result = await handleOrgRedirect(createTestRedirectParams({ query: { tag: ["a", "b"] } }));

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john?tag=a&tag=b");
    });

    it("strips orgRedirection", async () => {
      expectRedirectTo(
        await handleOrgRedirect(createTestRedirectParams({ query: { orgRedirection: "true" } })),
        "https://cal.bespokesoft.pl/john"
      );
      expectRedirectTo(
        await handleOrgRedirect(createTestRedirectParams({ query: { orgRedirection: "true", a: "1" } })),
        "https://cal.bespokesoft.pl/john?a=1"
      );
    });

    it("drops undefined values", async () => {
      const result = await handleOrgRedirect(createTestRedirectParams({ query: { a: undefined, b: "2" } }));

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john?b=2");
    });

    it("encodes special characters", async () => {
      const result = await handleOrgRedirect(createTestRedirectParams({ query: { name: "a b&c=d" } }));

      expectRedirectTo(result, "https://cal.bespokesoft.pl/john?name=a%20b%26c%3Dd");
    });
  });
});

describe("omitRouteParams", () => {
  it("removes keys present in route params", () => {
    expect(
      omitRouteParams({ user: "john87", type: "30min", month: "2026-11" }, { user: "john87", type: "30min" })
    ).toEqual({
      month: "2026-11",
    });
  });

  it("returns a copy when params are undefined", () => {
    const query = { month: "2026-11" };
    const result = omitRouteParams(query, undefined);

    expect(result).toEqual(query);
    expect(result).not.toBe(query);
  });
});

describe("getRedirectWithOriginAndSearchString", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRedirectScenario([]);
  });

  it("returns the origin and search string of the destination", async () => {
    createRedirectScenario([{ from: "john87", toUrl: "https://cal.bespokesoft.pl/john" }]);

    const result = await getRedirectWithOriginAndSearchString({
      slugs: ["john87"],
      redirectType: "User",
      query: { duration: "30", orgRedirection: "true" },
      hostOrgId: null,
    });

    expect(result).toEqual({ origin: "https://cal.bespokesoft.pl", searchString: "?duration=30" });
  });

  it("returns null when no redirect exists", async () => {
    const result = await getRedirectWithOriginAndSearchString({
      slugs: ["john87"],
      redirectType: "User",
      query: {},
      hostOrgId: null,
    });

    expect(result).toBeNull();
  });
});
