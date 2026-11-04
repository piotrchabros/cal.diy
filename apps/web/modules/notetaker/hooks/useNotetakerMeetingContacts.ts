"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { showToast } from "@calcom/ui/components/toast";

export function useNotetakerMeetingContacts() {
  const { t } = useLocale();
  const utils = trpc.useUtils();

  const setMeetingContacts = trpc.viewer.notetaker.setMeetingContacts.useMutation({
    onSuccess: async () => {
      await utils.viewer.notetaker.getState.invalidate();
      showToast(t("notetaker_contact_emails_saved"), "success");
    },
    onError: (error) => {
      showToast(
        t(
          error.data?.code === "TOO_MANY_REQUESTS"
            ? "notetaker_ad_hoc_rate_limited"
            : "notetaker_update_failed"
        ),
        "error"
      );
    },
  });

  return { setMeetingContacts };
}
