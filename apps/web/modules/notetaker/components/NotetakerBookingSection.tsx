"use client";

import type { NotetakerIneligibilityReasonDto, NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Alert } from "@calcom/ui/components/alert";
import { Button } from "@calcom/ui/components/button";
import {
  ConfirmationDialogContent,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@calcom/ui/components/dialog";
import { Switch } from "@calcom/ui/components/form";
import Link from "next/link";
import { useState } from "react";
import { useNotetakerMutations } from "../hooks/useNotetakerMutations";
import { useNotetakerState } from "../hooks/useNotetakerState";
import { NotetakerStatusBadge } from "./NotetakerStatusBadge";

const INELIGIBILITY_REASON_KEYS: Record<NotetakerIneligibilityReasonDto, string> = {
  FEATURE_DISABLED: "notetaker_unavailable_feature_disabled",
  UNSUPPORTED_PLATFORM: "notetaker_unavailable_unsupported_platform",
  CAL_VIDEO: "notetaker_unavailable_cal_video",
  IN_PERSON_OR_PHONE: "notetaker_unavailable_in_person_or_phone",
  NO_MEETING_LINK: "notetaker_unavailable_no_meeting_link",
  BOOKING_NOT_ACTIVE: "notetaker_unavailable_booking_not_active",
  MEETING_ENDED: "notetaker_unavailable_meeting_ended",
  REJOIN_BLOCKED: "notetaker_unavailable_rejoin_blocked",
};

// An attendee reads shared results but cannot change the choice or stop the notetaker, so only the status and the link are shown
function NotetakerAttendeeSection({
  bookingUid,
  state,
}: {
  bookingUid: string;
  state: NotetakerStateDto;
}): JSX.Element {
  const { t } = useLocale();

  return (
    <div className="flex flex-col gap-1" data-testid="notetaker-booking-section">
      <h3 className="font-medium text-subtle text-xs">{t("notetaker_section_title")}</h3>
      {state.status !== null && (
        <div className="flex">
          <NotetakerStatusBadge
            status={state.status}
            outcomeReason={state.session?.status === state.status ? state.session.outcomeReason : null}
          />
        </div>
      )}
      {state.transcript !== null && (
        <Link
          href={`/booking/${bookingUid}/notetaker`}
          className="text-emphasis text-sm underline"
          data-testid="notetaker-view-transcript">
          {t("notetaker_view_transcript")}
        </Link>
      )}
    </div>
  );
}

export function NotetakerBookingSection({ bookingUid }: { bookingUid: string }): JSX.Element | null {
  const { t, i18n } = useLocale();
  const { data: state, isPending, isError } = useNotetakerState(bookingUid);
  const { setEnabled, stop } = useNotetakerMutations();
  const [isStopDialogOpen, setIsStopDialogOpen] = useState(false);
  const [pendingScope, setPendingScope] = useState<boolean | null>(null);

  if (isPending || isError || !state) return null;
  if (!state.featureEnabled) return null;

  if (state.viewerRole === "ATTENDEE") {
    return <NotetakerAttendeeSection bookingUid={bookingUid} state={state} />;
  }

  const isRejoinBlocked = state.eligibility.reason === "REJOIN_BLOCKED";

  const choiceText = (() => {
    if (!state.choice) return null;
    const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(state.choice.setAt)
    );
    const name = state.choice.setByName;
    if (state.choice.enabled) {
      if (state.choice.source === "EVENT_TYPE_DEFAULT")
        return t("notetaker_enabled_by_event_type_default", { date });
      if (name) return t("notetaker_enabled_by", { name, date });
      return t("notetaker_enabled_at", { date });
    }
    if (name) return t("notetaker_disabled_by", { name, date });
    return t("notetaker_disabled_at", { date });
  })();

  const confirmScope = (scope: "THIS_BOOKING" | "ALL_FUTURE_OCCURRENCES"): void => {
    if (pendingScope === null) return;
    setEnabled.mutate({ bookingUid, enabled: pendingScope, scope });
    setPendingScope(null);
  };

  return (
    <div className="flex flex-col gap-1" data-testid="notetaker-booking-section">
      <h3 className="font-medium text-subtle text-xs">{t("notetaker_section_title")}</h3>
      {state.status === "WAITING_TO_BE_ADMITTED" && (
        <div data-testid="notetaker-admit-banner">
          <Alert
            severity="warning"
            title={t("notetaker_admit_banner_title")}
            message={t("notetaker_admit_banner_description")}
          />
        </div>
      )}
      {!isRejoinBlocked && (
        <>
          <Switch
            label={t("notetaker_toggle_label")}
            checked={state.choice?.enabled ?? false}
            disabled={!state.canToggle || setEnabled.isPending}
            onCheckedChange={(enabled: boolean) => {
              if (state.isRecurring) {
                setPendingScope(enabled);
                return;
              }
              setEnabled.mutate({ bookingUid, enabled, scope: "THIS_BOOKING" });
            }}
            data-testid="notetaker-toggle"
          />
          <p className="text-sm text-subtle">{t("notetaker_toggle_description")}</p>
          <Dialog
            open={pendingScope !== null}
            onOpenChange={(open) => {
              if (!open) setPendingScope(null);
            }}>
            <DialogContent
              title={t("notetaker_scope_title")}
              description={t("notetaker_scope_description")}
              data-testid="notetaker-scope-dialog">
              <DialogFooter>
                <DialogClose data-testid="notetaker-scope-cancel">{t("cancel")}</DialogClose>
                <Button
                  type="button"
                  color="secondary"
                  data-testid="notetaker-scope-this-booking"
                  onClick={() => confirmScope("THIS_BOOKING")}>
                  {t("notetaker_scope_this_booking")}
                </Button>
                <Button
                  type="button"
                  data-testid="notetaker-scope-all-future-occurrences"
                  onClick={() => confirmScope("ALL_FUTURE_OCCURRENCES")}>
                  {t("notetaker_scope_all_future_occurrences")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
      {state.eligibility.reason !== null && (
        <p
          className="text-default text-sm"
          data-testid={isRejoinBlocked ? "notetaker-rejoin-blocked" : undefined}>
          {t(INELIGIBILITY_REASON_KEYS[state.eligibility.reason])}
        </p>
      )}
      {state.status !== null && (
        <div className="flex">
          {/* A re-armed choice reports SCHEDULED while state.session is still the previous session; its reason must not be shown beside the new status */}
          <NotetakerStatusBadge
            status={state.status}
            outcomeReason={state.session?.status === state.status ? state.session.outcomeReason : null}
          />
        </div>
      )}
      {state.canStop && (
        <div className="flex">
          <Button
            type="button"
            color="destructive"
            size="sm"
            disabled={stop.isPending}
            onClick={() => setIsStopDialogOpen(true)}
            data-testid="notetaker-stop-button">
            {t("notetaker_stop_button")}
          </Button>
          <Dialog open={isStopDialogOpen} onOpenChange={setIsStopDialogOpen}>
            <ConfirmationDialogContent
              variety="danger"
              title={t("notetaker_stop_confirm_title")}
              confirmBtnText={t("notetaker_stop_button")}
              onConfirm={() => stop.mutate({ bookingUid })}>
              {t("notetaker_stop_confirm_description")}
            </ConfirmationDialogContent>
          </Dialog>
        </div>
      )}
      {choiceText !== null && <p className="text-subtle text-xs">{choiceText}</p>}
      {state.transcript === null && state.session?.resultsDeletedAt != null && (
        <p className="text-sm text-subtle" data-testid="notetaker-results-deleted">
          {t("notetaker_results_deleted")}
        </p>
      )}
      {state.transcript !== null && (
        <Link
          href={`/booking/${bookingUid}/notetaker`}
          className="text-emphasis text-sm underline"
          data-testid="notetaker-view-transcript">
          {t("notetaker_view_transcript")}
        </Link>
      )}
    </div>
  );
}
