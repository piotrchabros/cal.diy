import type { GetServerSidePropsContext } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../stripepayment/pages/setup/_getServerSideProps", () => ({
  getServerSideProps: vi.fn(),
}));
vi.mock("../../../alby/pages/setup/_getServerSideProps", () => ({ getServerSideProps: vi.fn() }));
vi.mock("../../../make/pages/setup/_getServerSideProps", () => ({ getServerSideProps: vi.fn() }));
vi.mock("../../../hitpay/pages/setup/_getServerSideProps", () => ({ getServerSideProps: vi.fn() }));
vi.mock("../../../btcpayserver/pages/setup/_getServerSideProps", () => ({ getServerSideProps: vi.fn() }));

import { getServerSideProps as stripeGetServerSideProps } from "../../../stripepayment/pages/setup/_getServerSideProps";
import { getServerSideProps } from "../_getServerSideProps";
import type { AppSetupPageDeps } from "../types";

const mockStripeGetServerSideProps = vi.mocked(stripeGetServerSideProps);
const deps: AppSetupPageDeps = { getServerSession: vi.fn<AppSetupPageDeps["getServerSession"]>() };

function createMockContext(overrides: Partial<GetServerSidePropsContext> = {}): GetServerSidePropsContext {
  return {
    req: { headers: {} } as GetServerSidePropsContext["req"],
    res: {} as GetServerSidePropsContext["res"],
    params: { slug: "stripe" },
    query: {},
    resolvedUrl: "/apps/stripe/setup",
    ...overrides,
  };
}

describe("App setup page getServerSideProps dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns notFound when slug is not a string", async () => {
    const result = await getServerSideProps(createMockContext({ params: { slug: ["stripe"] } }), deps);

    expect(result).toEqual({ notFound: true });
    expect(mockStripeGetServerSideProps).not.toHaveBeenCalled();
  });

  it("returns empty props for an unknown slug", async () => {
    const result = await getServerSideProps(createMockContext({ params: { slug: "unknown-app" } }), deps);

    expect(result).toEqual({ props: {} });
    expect(mockStripeGetServerSideProps).not.toHaveBeenCalled();
  });

  it("forwards ctx and deps to the stripe setup page", async () => {
    const redirect = {
      redirect: { destination: "https://connect.stripe.com/oauth/authorize", permanent: false },
    };
    mockStripeGetServerSideProps.mockResolvedValue(redirect);
    const ctx = createMockContext();

    const result = await getServerSideProps(ctx, deps);

    expect(mockStripeGetServerSideProps).toHaveBeenCalledWith(ctx, deps);
    expect(result).toBe(redirect);
  });
});
