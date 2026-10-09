"use client";

import type { NotetakerIneligibilityReasonDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { showToast } from "@calcom/ui/components/toast";

const INELIGIBILITY_REASONS: readonly string[] = [
  "FEATURE_DISABLED",
  "UNSUPPORTED_PLATFORM",
  "CAL_VIDEO",
  "IN_PERSON_OR_PHONE",
  "NO_MEETING_LINK",
  "BOOKING_NOT_ACTIVE",
  "MEETING_ENDED",
  "REJOIN_BLOCKED",
];

function isIneligibilityReason(value: string): value is NotetakerIneligibilityReasonDto {
  return INELIGIBILITY_REASONS.includes(value);
}

export function useNotetakerMutations() {
  const { t } = useLocale();
  const utils = trpc.useUtils();

  // The server sends the reason code as the BadRequest message because ErrorWithCode.data is dropped by the tRPC conversion.
  const getErrorMessage = (message: string): string => {
    if (!isIneligibilityReason(message)) return t("notetaker_update_failed");
    switch (message) {
      case "FEATURE_DISABLED":
        return t("notetaker_unavailable_feature_disabled");
      case "UNSUPPORTED_PLATFORM":
        return t("notetaker_unavailable_unsupported_platform");
      case "CAL_VIDEO":
        return t("notetaker_unavailable_cal_video");
      case "IN_PERSON_OR_PHONE":
        return t("notetaker_unavailable_in_person_or_phone");
      case "NO_MEETING_LINK":
        return t("notetaker_unavailable_no_meeting_link");
      case "BOOKING_NOT_ACTIVE":
        return t("notetaker_unavailable_booking_not_active");
      case "MEETING_ENDED":
        return t("notetaker_unavailable_meeting_ended");
      case "REJOIN_BLOCKED":
        return t("notetaker_unavailable_rejoin_blocked");
    }
  };

  const setEnabled = trpc.viewer.notetaker.setEnabled.useMutation({
    onSuccess: async () => {
      await utils.viewer.notetaker.getState.invalidate();
    },
    onError: (error) => {
      showToast(getErrorMessage(error.message), "error");
    },
  });

  const stop = trpc.viewer.notetaker.stop.useMutation({
    onSuccess: async () => {
      await utils.viewer.notetaker.getState.invalidate();
      showToast(t("notetaker_stop_requested"), "success");
    },
    onError: (error) => {
      showToast(getErrorMessage(error.message), "error");
    },
  });

  const regenerateSummary = trpc.viewer.notetaker.regenerateSummary.useMutation({
    onSuccess: async () => {
      await utils.viewer.notetaker.getState.invalidate();
    },
    onError: (error) => {
      showToast(getErrorMessage(error.message), "error");
    },
  });

  return { setEnabled, stop, regenerateSummary };
}
