"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { showToast } from "@calcom/ui/components/toast";

const CANDIDATES_PAGE_SIZE = 20;

function getSaveErrorKey(code: string): string {
  switch (code) {
    case "NOT_A_TEAM_EVENT_TYPE":
      return "notetaker_sharing_error_not_a_team_event_type";
    case "PERSON_NOT_ELIGIBLE":
      return "notetaker_sharing_error_person_not_eligible";
    case "TOO_MANY_PEOPLE":
      return "notetaker_sharing_error_too_many_people";
    case "FEATURE_DISABLED":
      return "notetaker_unavailable_feature_disabled";
    default:
      return "notetaker_sharing_save_failed";
  }
}

export function useNotetakerEventTypeSharing(eventTypeId: number) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const query = trpc.viewer.notetaker.getEventTypeSharing.useQuery({ eventTypeId }, { retry: false });
  const save = trpc.viewer.notetaker.setEventTypeSharing.useMutation({
    onSuccess: (updated) => {
      utils.viewer.notetaker.getEventTypeSharing.setData({ eventTypeId }, updated);
      showToast(t("notetaker_sharing_saved"), "success");
    },
    // The server sends the error code as the message.
    onError: (error) => {
      showToast(t(getSaveErrorKey(error.message)), "error");
    },
  });
  return { query, save };
}

export function useNotetakerSharingCandidates(params: {
  eventTypeId: number;
  search: string;
  enabled: boolean;
}) {
  const search = params.search.trim();
  return trpc.viewer.notetaker.listEventTypeSharingCandidates.useInfiniteQuery(
    {
      eventTypeId: params.eventTypeId,
      search: search === "" ? undefined : search,
      limit: CANDIDATES_PAGE_SIZE,
    },
    {
      enabled: params.enabled,
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }
  );
}
