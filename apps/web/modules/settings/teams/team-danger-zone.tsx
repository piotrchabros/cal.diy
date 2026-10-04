"use client";

import { Dialog } from "@calcom/features/components/controlled-dialog";
import SectionBottomActions from "@calcom/features/settings/SectionBottomActions";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { MembershipRole } from "@calcom/prisma/enums";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { DialogContent, DialogFooter, DialogTrigger } from "@calcom/ui/components/dialog";
import { Label } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";

type TeamDangerZoneProps = {
  teamId: number;
  role: MembershipRole;
};

const TeamDangerZone = ({ teamId, role }: TeamDangerZoneProps) => {
  const { t } = useLocale();
  const router = useRouter();
  const [disbandOpen, setDisbandOpen] = useState(false);

  const disbandMutation = trpc.viewer.teams.disband.useMutation({
    onSuccess: () => {
      showToast(t("team_deleted_successfully"), "success");
      setDisbandOpen(false);
      router.push("/settings/my-account/profile");
    },
    onError: () => {
      showToast(t("error_disbanding_team"), "error");
    },
  });

  if (role !== MembershipRole.OWNER) {
    return null;
  }

  return (
    <>
      <div className="mt-6 rounded-lg rounded-b-none border border-subtle border-b-0 p-6">
        <Label className="mb-0 font-semibold text-base text-red-700">{t("danger_zone")}</Label>
        <p className="text-sm text-subtle">{t("team_deletion_cannot_be_undone")}</p>
      </div>
      <Dialog open={disbandOpen} onOpenChange={setDisbandOpen}>
        <SectionBottomActions align="end">
          <DialogTrigger asChild>
            <Button data-testid="disband-team" color="destructive" className="mt-1" StartIcon="trash-2">
              {t("disband_team")}
            </Button>
          </DialogTrigger>
        </SectionBottomActions>
        <DialogContent
          title={t("disband_team")}
          description={t("disband_team_confirmation_message")}
          type="creation"
          Icon="triangle-alert">
          <DialogFooter>
            <Button color="minimal" onClick={() => setDisbandOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              color="destructive"
              data-testid="confirm-disband-team"
              loading={disbandMutation.isPending}
              onClick={() => disbandMutation.mutate({ teamId })}>
              {t("confirm_disband_team")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TeamDangerZone;
