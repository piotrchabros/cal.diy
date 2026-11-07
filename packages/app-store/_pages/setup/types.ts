import type { GetServerSidePropsContext } from "next";
import type { Session } from "next-auth";

export type AppSetupPageDeps = {
  getServerSession: (options: { req: GetServerSidePropsContext["req"] }) => Promise<Session | null>;
};
