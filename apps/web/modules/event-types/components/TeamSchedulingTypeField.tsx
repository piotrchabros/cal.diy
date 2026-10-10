import type { createEventTypeInput } from "@calcom/features/eventtypes/lib/types";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { SchedulingType } from "@calcom/prisma/enums";
import { RadioAreaGroup as RadioArea } from "@calcom/ui/components/radio";
import { useEffect } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { z } from "zod";

type CreateEventTypeFormValues = z.infer<typeof createEventTypeInput>;

export type TeamSchedulingTypeFieldProps = {
  form: UseFormReturn<CreateEventTypeFormValues>;
  teamId: number;
};

export function TeamSchedulingTypeField({ form, teamId }: TeamSchedulingTypeFieldProps) {
  const { t } = useLocale();
  const schedulingType = form.watch("schedulingType");
  const errorMessage = form.formState.errors.schedulingType?.message;

  // The dialog and its form stay mounted while the user switches between a team and the personal
  // profile; a stale teamId would create a personal event type on the team.
  useEffect(() => {
    form.setValue("teamId", teamId);
    const current = form.getValues("schedulingType");
    if (current !== SchedulingType.COLLECTIVE && current !== SchedulingType.ROUND_ROBIN) {
      form.setValue("schedulingType", SchedulingType.COLLECTIVE);
    }
    return () => {
      form.setValue("teamId", undefined);
      form.setValue("schedulingType", undefined);
    };
  }, [form, teamId]);

  return (
    <div className="mt-5">
      <label className="text-emphasis mb-2 block text-sm font-medium">{t("scheduling_type")}</label>
      <RadioArea.Group
        data-testid="team-scheduling-type"
        value={schedulingType ?? undefined}
        onValueChange={(value) => {
          if (value === SchedulingType.COLLECTIVE || value === SchedulingType.ROUND_ROBIN) {
            form.setValue("schedulingType", value, { shouldValidate: true });
          }
        }}
        className="flex flex-col gap-2">
        <RadioArea.Item
          value={SchedulingType.COLLECTIVE}
          data-testid="scheduling-type-collective"
          className="w-full">
          <strong className="text-emphasis mb-1 block">{t("collective")}</strong>
          <p className="text-subtle text-sm">{t("collective_description")}</p>
        </RadioArea.Item>
        <RadioArea.Item
          value={SchedulingType.ROUND_ROBIN}
          data-testid="scheduling-type-round-robin"
          className="w-full">
          <strong className="text-emphasis mb-1 block">{t("round_robin")}</strong>
          <p className="text-subtle text-sm">{t("round_robin_description")}</p>
        </RadioArea.Item>
      </RadioArea.Group>
      <p data-testid="team-event-type-host-notice" className="text-subtle mt-2 text-sm">
        {t("team_event_type_creator_is_host")}
      </p>
      {errorMessage ? (
        <p data-testid="team-scheduling-type-error" className="text-error mt-2 text-sm">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
