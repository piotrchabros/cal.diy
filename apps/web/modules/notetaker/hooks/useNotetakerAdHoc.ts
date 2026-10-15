"use client";

import type { NotetakerAdHocErrorCode } from "@calcom/features/notetaker/services/NotetakerAdHocService";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { showToast } from "@calcom/ui/components/toast";

const ERROR_KEYS: Record<NotetakerAdHocErrorCode, string> = {
  FEATURE_DISABLED: "notetaker_ad_hoc_feature_disabled",
  PROVIDER_UNAVAILABLE: "notetaker_ad_hoc_provider_unavailable",
  INVALID_MEETING_LINK: "notetaker_ad_hoc_invalid_link",
  UNSUPPORTED_PLATFORM: "notetaker_ad_hoc_unsupported_platform",
  AD_HOC_LIMIT_REACHED: "notetaker_ad_hoc_limit_reached",
  TEAM_NOT_ALLOWED: "notetaker_ad_hoc_team_not_allowed",
  INVALID_DURATION: "notetaker_ad_hoc_invalid_duration",
};

function isAdHocErrorCode(value: string): value is NotetakerAdHocErrorCode {
  return Object.hasOwn(ERROR_KEYS, value);
}

type DispatchInput = {
  meetingUrl: string;
  title?: string;
  durationMinutes?: number;
  sharingTeamId: number | null;
  acknowledgedNotice: true;
};

export function useNotetakerAdHoc({ enabled }: { enabled: boolean }) {
  const { t } = useLocale();
  const utils = trpc.useUtils();

  const options = trpc.viewer.notetaker.getAdHocOptions.useQuery(undefined, { enabled });

  // The service sends its error code as the message because ErrorWithCode.data is dropped by the tRPC conversion.
  const getErrorMessage = (error: { message: string; data?: { code?: string } | null }): string => {
    if (error.data?.code === "TOO_MANY_REQUESTS") return t("notetaker_ad_hoc_rate_limited");
    if (!isAdHocErrorCode(error.message)) return t("notetaker_ad_hoc_failed");
    return t(ERROR_KEYS[error.message]);
  };

  const dispatchToMeeting = trpc.viewer.notetaker.dispatchToMeeting.useMutation({
    onSuccess: async (data) => {
      await utils.viewer.bookings.invalidate();
      showToast(t(data.reused ? "notetaker_ad_hoc_reused" : "notetaker_ad_hoc_dispatched"), "success");
    },
    onError: (error) => {
      showToast(getErrorMessage(error), "error");
    },
  });

  // Resolves to the new booking uid, or null when the request failed (the toast is already shown).
  const dispatch = async (input: DispatchInput): Promise<string | null> => {
    try {
      const result = await dispatchToMeeting.mutateAsync(input);
      return result.bookingUid;
    } catch {
      return null;
    }
  };

  return { options, dispatchToMeeting, dispatch };
}
