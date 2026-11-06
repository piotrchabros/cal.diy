import type { GetServerSideProps, GetServerSidePropsContext } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";

export const withAppDirSsr =
  <T extends Record<string, any>>(getServerSideProps: GetServerSideProps<T>) =>
  async (context: GetServerSidePropsContext) => {
    const ssrResponse = await getServerSideProps(context);

    if ("redirect" in ssrResponse) {
      const ssrRedirect = ssrResponse.redirect;
      if ("permanent" in ssrRedirect && ssrRedirect.permanent) {
        permanentRedirect(ssrRedirect.destination);
      } else {
        redirect(ssrRedirect.destination);
      }
    }
    if ("notFound" in ssrResponse) {
      notFound();
    }

    const props = await Promise.resolve(ssrResponse.props);

    return {
      ...props,
    };
  };
