import type { GetServerSidePropsContext, Redirect } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withAppDirSsr } from "./WithAppDirSsr";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
}));

const context = { query: {}, resolvedUrl: "/MOCKED_RESOLVED_URL" } as unknown as GetServerSidePropsContext;

function withRedirect(redirectConfig: Redirect) {
  return withAppDirSsr(async () => ({ redirect: redirectConfig }));
}

describe("withAppDirSsr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses permanentRedirect when the redirect is permanent", async () => {
    await withRedirect({ destination: "https://cal.acme.com/team/sales", permanent: true })(context);

    expect(permanentRedirect).toHaveBeenCalledWith("https://cal.acme.com/team/sales");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("uses redirect when the redirect is not permanent", async () => {
    await withRedirect({ destination: "/team/sales", permanent: false })(context);

    expect(redirect).toHaveBeenCalledWith("/team/sales");
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("uses redirect when the redirect specifies a statusCode", async () => {
    await withRedirect({ destination: "/team/sales", statusCode: 301 })(context);

    expect(redirect).toHaveBeenCalledWith("/team/sales");
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("calls notFound when gSSP returns notFound", async () => {
    await withAppDirSsr(async () => ({ notFound: true as const }))(context);

    expect(notFound).toHaveBeenCalled();
  });

  it("returns the props from gSSP", async () => {
    const result = await withAppDirSsr(async () => ({ props: { prop1: "value1" } }))(context);

    expect(result).toEqual({ prop1: "value1" });
    expect(redirect).not.toHaveBeenCalled();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });
});
