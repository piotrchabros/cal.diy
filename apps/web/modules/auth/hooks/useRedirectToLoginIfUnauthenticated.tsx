"use client";

import { useOrgBaseUrl } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect } from "react";

export function useRedirectToLoginIfUnauthenticated(isPublic = false) {
  const { data: session, status } = useSession();
  const loading = status === "loading";
  const router = useRouter();
  const orgBaseUrl = useOrgBaseUrl();
  useEffect(() => {
    if (isPublic) {
      return;
    }

    if (!loading && !session) {
      const urlSearchParams = new URLSearchParams();
      urlSearchParams.set("callbackUrl", `${orgBaseUrl}${location.pathname}${location.search}`);
      router.replace(`/auth/login?${urlSearchParams.toString()}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, session, isPublic, orgBaseUrl]);

  return {
    loading: loading && !session,
    session,
  };
}
