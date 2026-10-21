import AssignAllTeamMembers from "@calcom/features/eventtypes/components/AssignAllTeamMembers";
import type { CheckedSelectOption } from "@calcom/features/eventtypes/components/CheckedTeamSelect";
import CheckedTeamSelect from "@calcom/features/eventtypes/components/CheckedTeamSelect";
import type { Host, TeamMember } from "@calcom/features/eventtypes/lib/types";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import type { ComponentProps, Dispatch, SetStateAction } from "react";
import type { Options } from "react-select";
import { mergeHostsPreservingMeta } from "../lib/assignmentHosts";

const sortByLabel = (a: TeamMember, b: TeamMember) => {
  if (a.label < b.label) return -1;
  if (a.label > b.label) return 1;
  return 0;
};

type CheckedHostFieldProps = {
  placeholder: string;
  isFixed: boolean;
  value: Host[];
  onChange: (hosts: Host[]) => void;
  options: Options<CheckedSelectOption>;
  isRRWeightsEnabled?: boolean;
  groupId: string | null;
} & Omit<Partial<ComponentProps<typeof CheckedTeamSelect>>, "onChange" | "value" | "options">;

const CheckedHostField = ({
  placeholder,
  options,
  isFixed,
  value,
  onChange,
  isRRWeightsEnabled,
  groupId,
  ...rest
}: CheckedHostFieldProps) => {
  return (
    <div className="flex flex-col rounded-md">
      <CheckedTeamSelect
        isOptionDisabled={(option) => value.some((host) => host.userId.toString() === option.value)}
        onChange={(selected) => {
          const changed = selected.map((option) => ({
            isFixed,
            userId: parseInt(option.value, 10),
            priority: option.priority ?? 2,
            weight: option.weight ?? 100,
            scheduleId: option.defaultScheduleId ?? null,
            groupId: option.groupId,
          }));
          onChange(mergeHostsPreservingMeta(changed, value));
        }}
        value={value
          .filter((host) => host.isFixed === isFixed)
          .reduce<CheckedSelectOption[]>((acc, host) => {
            const option = options.find((member) => member.value === host.userId.toString());
            if (!option) return acc;

            acc.push({
              ...option,
              priority: host.priority ?? 2,
              isFixed,
              weight: host.weight ?? 100,
              groupId: host.groupId,
            });
            return acc;
          }, [])}
        controlShouldRenderValue={false}
        options={options}
        placeholder={placeholder}
        isRRWeightsEnabled={isRRWeightsEnabled}
        groupId={groupId}
        {...rest}
      />
    </div>
  );
};

export type AddMembersWithSwitchProps = {
  teamMembers: TeamMember[];
  value: Host[];
  onChange: (hosts: Host[]) => void;
  assignAllTeamMembers: boolean;
  setAssignAllTeamMembers: Dispatch<SetStateAction<boolean>>;
  automaticAddAllEnabled: boolean;
  onActive: () => void;
  isFixed: boolean;
  placeholder?: string;
  isRRWeightsEnabled?: boolean;
  groupId: string | null;
  "data-testid"?: string;
};

export function AddMembersWithSwitch({
  teamMembers,
  value,
  onChange,
  assignAllTeamMembers,
  setAssignAllTeamMembers,
  automaticAddAllEnabled,
  onActive,
  isFixed,
  placeholder,
  isRRWeightsEnabled,
  groupId,
  ...rest
}: AddMembersWithSwitchProps) {
  const { t } = useLocale();

  const assignAllToggle =
    automaticAddAllEnabled && !groupId ? (
      <AssignAllTeamMembers
        assignAllTeamMembers={assignAllTeamMembers}
        setAssignAllTeamMembers={setAssignAllTeamMembers}
        onActive={onActive}
      />
    ) : null;

  if (assignAllTeamMembers && automaticAddAllEnabled) return assignAllToggle;

  return (
    <>
      <div className="mb-2">{assignAllToggle}</div>
      <div className="mb-2">
        <CheckedHostField
          data-testid={rest["data-testid"]}
          value={value}
          onChange={onChange}
          isFixed={isFixed}
          className="mb-2"
          options={teamMembers.map((member) => ({ ...member, groupId })).sort(sortByLabel)}
          placeholder={placeholder ?? t("add_attendees")}
          isRRWeightsEnabled={isRRWeightsEnabled}
          groupId={groupId}
        />
      </div>
    </>
  );
}

export default function AddMembersWithSwitchWrapper({
  containerClassName,
  ...props
}: AddMembersWithSwitchProps & { containerClassName?: string }) {
  return (
    <div className="rounded-md">
      <div className={`flex flex-col rounded-md pb-2 pt-6 ${containerClassName ?? ""}`}>
        <AddMembersWithSwitch {...props} />
      </div>
    </div>
  );
}
