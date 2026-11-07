import type { GetServerSidePropsContext } from "next";
import type { AppSetupPageDeps } from "./types";

export const AppSetupPageMap = {
  alby: import("../../alby/pages/setup/_getServerSideProps"),
  make: import("../../make/pages/setup/_getServerSideProps"),
  stripe: import("../../stripepayment/pages/setup/_getServerSideProps"),
  hitpay: import("../../hitpay/pages/setup/_getServerSideProps"),
  btcpayserver: import("../../btcpayserver/pages/setup/_getServerSideProps"),
};

export const getServerSideProps = async (ctx: GetServerSidePropsContext, deps: AppSetupPageDeps) => {
  const { slug } = ctx.params || {};
  if (typeof slug !== "string") return { notFound: true } as const;

  if (!(slug in AppSetupPageMap)) return { props: {} };

  const page = await AppSetupPageMap[slug as keyof typeof AppSetupPageMap];

  if (!page.getServerSideProps) return { props: {} };

  const props = await page.getServerSideProps(ctx, deps);

  return props;
};
