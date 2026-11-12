"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Switch } from "@calcom/ui/components/form";
import { useNotetakerCalendarAutoJoin } from "../hooks/useNotetakerCalendarAutoJoin";

export function NotetakerCalendarAutoJoinSwitch({
  integration,
  externalId,
}: {
  integration: string;
  externalId: string;
}): JSX.Element | null {
  const { t } = useLocale();
  const { query, save, findCalendar } = useNotetakerCalendarAutoJoin();

  if (!query.data?.available) return null;
  const calendar = findCalendar(integration, externalId);
  if (!calendar || !calendar.supported) return null;

  const teamOptions = query.data.teamOptions;
  const selectId = `notetaker-calendar-auto-join-share-${calendar.selectedCalendarId}`;

  return (
    <div className="ml-14 flex flex-col gap-1" data-testid="notetaker-calendar-auto-join">
      <Switch
        size="sm"
        label={t("notetaker_calendar_auto_join_label")}
        checked={calendar.enabled}
        disabled={save.isPending}
        onCheckedChange={(enabled: boolean) => {
          save.mutate({
            selectedCalendarId: calendar.selectedCalendarId,
            enabled,
            sharingTeamId: calendar.sharingTeamId,
          });
        }}
        data-testid="notetaker-calendar-auto-join-toggle"
      />
      <p className="text-subtle text-xs">{t("notetaker_calendar_auto_join_description")}</p>
      {calendar.enabled && (
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="text-default text-xs">
            {t("notetaker_calendar_auto_join_share_label")}
          </label>
          <select
            id={selectId}
            className="rounded-md border border-default bg-default px-2 py-1 text-emphasis text-xs"
            value={calendar.sharingTeamId === null ? "" : String(calendar.sharingTeamId)}
            disabled={save.isPending}
            onChange={(event) => {
              const value = event.target.value;
              save.mutate({
                selectedCalendarId: calendar.selectedCalendarId,
                enabled: true,
                sharingTeamId: value === "" ? null : Number(value),
              });
            }}
            data-testid="notetaker-calendar-auto-join-share">
            <option value="">{t("notetaker_calendar_auto_join_share_only_me")}</option>
            {teamOptions.map((option) => (
              <option key={option.teamId} value={String(option.teamId)}>
                {option.isOrganization
                  ? t("notetaker_sharing_team_option_organization", {
                      name: option.name,
                      interpolation: { escapeValue: false },
                    })
                  : option.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {calendar.lastPollFailed && (
        <p className="text-attention text-xs" data-testid="notetaker-calendar-auto-join-poll-failed">
          {t("notetaker_calendar_auto_join_poll_failed")}
        </p>
      )}
    </div>
  );
}
