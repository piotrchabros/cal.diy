"use client";

import type { NotetakerActivityActionDto, NotetakerActivityDto } from "@calcom/lib/dto/NotetakerActivityDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";

const ACTION_KEYS: Record<NotetakerActivityActionDto, string> = {
  ENABLED: "notetaker_activity_enabled",
  DISABLED: "notetaker_activity_disabled",
  STOPPED: "notetaker_activity_stopped",
  SHARED: "notetaker_activity_shared",
  SHARING_REVOKED: "notetaker_activity_sharing_revoked",
  EXPORTED: "notetaker_activity_exported",
  DELETED: "notetaker_activity_deleted",
  SUMMARY_REQUESTED: "notetaker_activity_summary_requested",
  SHARED_VIEWED: "notetaker_activity_shared_viewed",
  SHARING_MODE_CHANGED: "notetaker_activity_sharing_mode_changed",
  SHARING_PEOPLE_CHANGED: "notetaker_activity_sharing_people_changed",
};

function getActorLabel(activity: NotetakerActivityDto, t: (key: string) => string): string {
  if (activity.actorType === "PARTICIPANT") return t("notetaker_activity_actor_participant");
  if (activity.actorType === "SYSTEM") return t("notetaker_activity_actor_system");
  if (activity.actorName !== null && activity.actorName.trim() !== "") return activity.actorName;
  return t("notetaker_activity_actor_unknown");
}

export function NotetakerActivityList({ bookingUid }: { bookingUid: string }): JSX.Element | null {
  const { t, i18n } = useLocale();
  const { data, isPending, isError } = trpc.viewer.notetaker.getActivity.useQuery(
    { bookingUid },
    { retry: false }
  );

  if (isPending || isError || !data) return null;

  const formatter = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section data-testid="notetaker-activity-list" className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">{t("notetaker_activity_title")}</h3>
      {data.length === 0 && <p className="text-sm text-subtle">{t("notetaker_activity_empty")}</p>}
      {data.length > 0 && (
        <ol className="flex flex-col gap-2">
          {data.map((activity) => (
            <li
              key={activity.id}
              data-testid="notetaker-activity-item"
              className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span>{t(ACTION_KEYS[activity.action])}</span>
              <span className="text-subtle">{getActorLabel(activity, t)}</span>
              <span className="text-subtle text-xs">
                <time dateTime={activity.createdAt}>{formatter.format(new Date(activity.createdAt))}</time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
