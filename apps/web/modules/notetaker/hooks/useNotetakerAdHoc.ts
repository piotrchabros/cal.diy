"use client";

import type { NotetakerAdHocErrorCode } from "@calcom/features/notetaker/services/NotetakerAdHocService";
import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { showToast } from "@calcom/ui/components/toast";

const ERROR_KEYS: Record<NotetakerAdHocErrorCode, string> = {
  FEATURE_DISABLED: "notetaker_ad_hoc_feature_disabled",
  PROVIDER_UNAVAILABLE: "notetaker_ad_hoc_provider_unavailable",
  INVALID_MEETING_LINK: "notetaker_ad_hoc_invalid_link",
  UNSUPPORTED_PLATFORM: "notetaker_ad_hoc_unsupported_platform",
  WRAPPED_MEETING_LINK: "notetaker_ad_hoc_wrapped_link",
  AD_HOC_LIMIT_REACHED: "notetaker_ad_hoc_limit_reached",
  TEAM_NOT_ALLOWED: "notetaker_ad_hoc_team_not_allowed",
  INVALID_DURATION: "notetaker_ad_hoc_invalid_duration",
};

export type AdHocLinkCopyVariant = "meet" | "teams" | "any";

type AdHocLinkCopyKeys = {
  label: string;
  description: string;
  invalid: string;
  unsupported: string;
  placeholder: string;
};

const MEET_PLACEHOLDER = "https://meet.google.com/abc-defg-hij";
const TEAMS_PLACEHOLDER = "https://teams.microsoft.com/meet/123456789012?p=AbCdEf";

// The unsuffixed keys predate Teams support and stay as the Meet copy.
const LINK_COPY_KEYS: Record<AdHocLinkCopyVariant, AdHocLinkCopyKeys> = {
  meet: {
    label: "notetaker_meeting_link_label",
    description: "notetaker_add_to_meeting_description",
    invalid: "notetaker_ad_hoc_invalid_link",
    unsupported: "notetaker_ad_hoc_unsupported_platform",
    placeholder: MEET_PLACEHOLDER,
  },
  teams: {
    label: "notetaker_meeting_link_label_teams",
    description: "notetaker_add_to_meeting_description_teams",
    invalid: "notetaker_ad_hoc_invalid_link_teams",
    unsupported: "notetaker_ad_hoc_unsupported_platform_teams",
    placeholder: TEAMS_PLACEHOLDER,
  },
  any: {
    label: "notetaker_meeting_link_label_any",
    description: "notetaker_add_to_meeting_description_any",
    invalid: "notetaker_ad_hoc_invalid_link_any",
    unsupported: "notetaker_ad_hoc_unsupported_platform_any",
    placeholder: MEET_PLACEHOLDER,
  },
};

export function getAdHocLinkCopyVariant(
  enabledPlatforms: readonly NotetakerPlatformDto[] | undefined
): AdHocLinkCopyVariant {
  const meet = enabledPlatforms?.includes("GOOGLE_MEET") ?? false;
  const teams = enabledPlatforms?.includes("MICROSOFT_TEAMS") ?? false;
  if (meet && teams) return "any";
  if (teams) return "teams";
  return "meet";
}

export function getAdHocLinkCopyKeys(variant: AdHocLinkCopyVariant): AdHocLinkCopyKeys {
  return LINK_COPY_KEYS[variant];
}

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
    const copyKeys = getAdHocLinkCopyKeys(getAdHocLinkCopyVariant(options.data?.enabledPlatforms));
    if (error.message === "INVALID_MEETING_LINK") return t(copyKeys.invalid);
    if (error.message === "UNSUPPORTED_PLATFORM") return t(copyKeys.unsupported);
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
