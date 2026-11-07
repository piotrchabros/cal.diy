import { useOrgBaseUrlOr } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { WEBSITE_URL } from "@calcom/lib/constants";
import { localeOptions } from "@calcom/lib/i18n";
import { useSession } from "next-auth/react";
import type { EventSetupTabProps } from "./EventSetupTab";
import { EventSetupTab } from "./EventSetupTab";

const EventSetupTabWebWrapper = (props: EventSetupTabProps) => {
  const orgBranding = null;
  const session = useSession();
  const publicBase = useOrgBaseUrlOr(WEBSITE_URL);
  const urlPrefix = orgBranding
    ? "".replace(/^(https?:|)\/\//, "")
    : `${publicBase?.replace(/^(https?:|)\/\//, "")}`;
  return (
    <EventSetupTab
      urlPrefix={urlPrefix}
      hasOrgBranding={!!orgBranding}
      orgId={session.data?.user.org?.id}
      localeOptions={localeOptions}
      {...props}
    />
  );
};

export default EventSetupTabWebWrapper;
