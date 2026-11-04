"use client";

import type {
  NotetakerCalendarAutoJoinSettingDto,
  NotetakerCalendarAutoJoinSettingsDto,
} from "@calcom/lib/dto/NotetakerCalendarAutoJoinDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { showToast } from "@calcom/ui/components/toast";

export type NotetakerCalendarAutoJoinChange = {
  selectedCalendarId: string;
  enabled: boolean;
  sharingTeamId: number | null;
};

export function getCalendarAutoJoinKey(integration: string, externalId: string): string {
  return `${integration}:${externalId}`;
}

function applyChange(
  settings: NotetakerCalendarAutoJoinSettingsDto,
  change: NotetakerCalendarAutoJoinChange
): NotetakerCalendarAutoJoinSettingsDto {
  return {
    ...settings,
    calendars: settings.calendars.map((calendar) =>
      calendar.selectedCalendarId === change.selectedCalendarId
        ? { ...calendar, enabled: change.enabled, sharingTeamId: change.sharingTeamId }
        : calendar
    ),
  };
}

export function useNotetakerCalendarAutoJoin() {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const query = trpc.viewer.notetaker.listCalendarAutoJoin.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const save = trpc.viewer.notetaker.setCalendarAutoJoin.useMutation({
    onMutate: async (change) => {
      await utils.viewer.notetaker.listCalendarAutoJoin.cancel();
      const previous = utils.viewer.notetaker.listCalendarAutoJoin.getData();
      if (previous)
        utils.viewer.notetaker.listCalendarAutoJoin.setData(undefined, applyChange(previous, change));
      return { previous };
    },
    onError: (_error, _change, context) => {
      if (context?.previous) utils.viewer.notetaker.listCalendarAutoJoin.setData(undefined, context.previous);
      showToast(t("notetaker_calendar_auto_join_save_failed"), "error");
    },
    onSettled: () => {
      void utils.viewer.notetaker.listCalendarAutoJoin.invalidate();
    },
  });

  const byKey = new Map<string, NotetakerCalendarAutoJoinSettingDto>();
  for (const calendar of query.data?.calendars ?? []) {
    byKey.set(getCalendarAutoJoinKey(calendar.integration, calendar.externalId), calendar);
  }

  const findCalendar = (integration: string, externalId: string) =>
    byKey.get(getCalendarAutoJoinKey(integration, externalId)) ?? null;
  const findCalendarById = (selectedCalendarId: string) =>
    query.data?.calendars.find((calendar) => calendar.selectedCalendarId === selectedCalendarId) ?? null;

  return { query, save, findCalendar, findCalendarById };
}
