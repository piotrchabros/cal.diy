import AppCard from "@calcom/app-store/_components/AppCard";
import { getAppReturnToUrl } from "@calcom/app-store/_utils/getAppReturnToUrl";
import useIsAppEnabled from "@calcom/app-store/_utils/useIsAppEnabled";
import type { EventTypeAppCardComponent } from "@calcom/app-store/types";
import { usePathname } from "next/navigation";

const EventTypeAppCard: EventTypeAppCardComponent = function EventTypeAppCard({
  app,
  eventType,
  onAppInstallSuccess,
}) {
  const pathname = usePathname();

  const { enabled, updateEnabled } = useIsAppEnabled(app);

  return (
    <AppCard
      onAppInstallSuccess={onAppInstallSuccess}
      returnTo={getAppReturnToUrl(`${pathname}?tabName=apps`)}
      app={app}
      teamId={eventType.team?.id || undefined}
      switchOnClick={(e) => {
        updateEnabled(e);
      }}
      switchChecked={enabled}
      hideAppCardOptions
    />
  );
};

export default EventTypeAppCard;
