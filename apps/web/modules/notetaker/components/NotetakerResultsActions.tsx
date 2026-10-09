"use client";

import { NOTETAKER_LIVE_SESSION_STATUSES } from "@calcom/features/notetaker/lib/sessionStateMachine";
import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { ConfirmationDialogContent, Dialog } from "@calcom/ui/components/dialog";
import { useNotetakerMutations } from "@calcom/web/modules/notetaker/hooks/useNotetakerMutations";
import { useState } from "react";

export function NotetakerResultsActions({
  bookingUid,
  viewerRole,
  sharedWithAttendees,
  sessionStatus,
}: {
  bookingUid: string;
  viewerRole: "HOST" | "ATTENDEE";
  sharedWithAttendees: boolean;
  sessionStatus: NotetakerSessionStatusDto | null;
}) {
  const { t } = useLocale();
  const { setSharing, exportResults, deleteResults } = useNotetakerMutations();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const isHost = viewerRole === "HOST";
  const isLive = sessionStatus !== null && NOTETAKER_LIVE_SESSION_STATUSES.includes(sessionStatus);

  return (
    <div className="flex flex-col gap-2" data-testid="notetaker-results-actions">
      <div className="flex">
        <Button
          type="button"
          color="secondary"
          size="sm"
          loading={exportResults.isPending}
          onClick={() => exportResults.mutate({ bookingUid, format: "markdown" })}
          data-testid="notetaker-export-button">
          {t("notetaker_export")}
        </Button>
      </div>
      {isHost && (
        <>
          <div className="flex">
            <Button
              type="button"
              color="secondary"
              size="sm"
              aria-pressed={sharedWithAttendees}
              disabled={setSharing.isPending}
              onClick={() => setSharing.mutate({ bookingUid, shared: !sharedWithAttendees })}
              data-testid="notetaker-share-toggle">
              {sharedWithAttendees ? t("notetaker_stop_sharing") : t("notetaker_share_with_attendees")}
            </Button>
          </div>
          {sharedWithAttendees ? (
            <p className="text-subtle text-xs" data-testid="notetaker-shared-status">
              {t("notetaker_shared_status")}
            </p>
          ) : (
            <p className="text-subtle text-xs">{t("notetaker_share_description")}</p>
          )}
          <div className="flex">
            <Button
              type="button"
              color="destructive"
              size="sm"
              disabled={isLive || deleteResults.isPending}
              onClick={() => setIsDeleteDialogOpen(true)}
              data-testid="notetaker-delete-button">
              {t("notetaker_delete_results")}
            </Button>
            <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
              <ConfirmationDialogContent
                variety="danger"
                title={t("notetaker_delete_results_confirm_title")}
                confirmBtnText={t("notetaker_delete_results")}
                onConfirm={() => deleteResults.mutate({ bookingUid })}>
                {t("notetaker_delete_results_confirm_description")}
              </ConfirmationDialogContent>
            </Dialog>
          </div>
        </>
      )}
    </div>
  );
}
