import AssignAllTeamMembers from "@calcom/features/eventtypes/components/AssignAllTeamMembers";
import type { ChildrenEventType } from "@calcom/features/eventtypes/components/ChildrenEventTypeSelect";
import ChildrenEventTypeSelect from "@calcom/features/eventtypes/components/ChildrenEventTypeSelect";
import { LearnMoreLink } from "@calcom/features/eventtypes/components/LearnMoreLink";
import type {
  EventTypeSetupProps,
  FormValues,
  Host,
  TeamMember,
} from "@calcom/features/eventtypes/lib/types";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { SchedulingType } from "@calcom/prisma/enums";
import { Button } from "@calcom/ui/components/button";
import { Label, Select, SettingsToggle } from "@calcom/ui/components/form";
import { Icon } from "@calcom/ui/components/icon";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { v4 as uuidv4 } from "uuid";
import {
  addHostGroup,
  buildHostsForAllMembers,
  isAssignableMember,
  mapMemberToChildrenOption,
  mapUserToValue,
  mergeHostsPreservingMeta,
  removeFixedHosts,
  removeHostGroup,
  replaceHostsOfKind,
  sortRoundRobinHosts,
} from "../../../lib/assignmentHosts";
import AddMembersWithSwitch from "../../AddMembersWithSwitch";

export type EventTeamAssignmentTabProps = Pick<EventTypeSetupProps, "teamMembers" | "team" | "eventType">;

type ChildrenOption = ReturnType<typeof mapMemberToChildrenOption>;

const ROUND_ROBIN_HELP_URL = "https://cal.com/help/event-types/round-robin";
const FIXED_HOSTS_HELP_URL =
  "https://cal.com/docs/enterprise-features/teams/round-robin-scheduling#fixed-hosts";

const ChildrenEventTypesList = ({
  options,
  value,
  onChange,
}: {
  options: ChildrenOption[];
  value: ChildrenEventType[];
  onChange: (children: ChildrenEventType[]) => void;
}) => {
  const { t } = useLocale();
  const selectedOwnerIds = new Set(value.map((child) => child.owner.id.toString()));

  return (
    <div className="stack-y-5 flex flex-col">
      <div>
        <Label>{t("assign_to")}</Label>
        <ChildrenEventTypeSelect
          aria-label="assignment-dropdown"
          data-testid="assignment-dropdown"
          onChange={(selected) => onChange([...selected])}
          value={value}
          options={options.filter((option) => !selectedOwnerIds.has(option.value))}
          controlShouldRenderValue={false}
        />
      </div>
    </div>
  );
};

const FixedHostHelper = () => {
  const { t } = useLocale();
  return <LearnMoreLink t={t} i18nKey="fixed_host_helper" href={FIXED_HOSTS_HELP_URL} />;
};

const FixedHosts = ({
  teamMembers,
  value,
  onChange,
  assignAllTeamMembers,
  setAssignAllTeamMembers,
  isRoundRobinEvent = false,
}: {
  value: Host[];
  onChange: (hosts: Host[]) => void;
  teamMembers: TeamMember[];
  assignAllTeamMembers: boolean;
  setAssignAllTeamMembers: Dispatch<SetStateAction<boolean>>;
  isRoundRobinEvent?: boolean;
}) => {
  const { t } = useLocale();
  const { getValues, setValue } = useFormContext<FormValues>();

  const [isFixedHostsEnabled, setIsFixedHostsEnabled] = useState(
    () => isRoundRobinEvent && getValues("hosts").some((host) => host.isFixed)
  );

  const handleFixedHostsActivation = useCallback(() => {
    setValue(
      "hosts",
      buildHostsForAllMembers({
        teamMembers,
        currentHosts: getValues("hosts"),
        isFixed: true,
        groupId: null,
      }),
      { shouldDirty: true }
    );
  }, [getValues, setValue, teamMembers]);

  const handleFixedHostsToggle = useCallback(
    (checked: boolean) => {
      if (!checked) {
        setValue("hosts", removeFixedHosts(getValues("hosts")), { shouldDirty: true });
      }
      setIsFixedHostsEnabled(checked);
    },
    [getValues, setValue]
  );

  if (!isRoundRobinEvent) {
    return (
      <div className="mt-5 rounded-lg">
        <div className="border-subtle mt-5 rounded-t-md border p-6 pb-5">
          <Label className="mb-1 text-sm font-semibold">{t("fixed_hosts")}</Label>
          <p className="text-subtle wrap-break-word max-w-full text-sm leading-tight">
            <FixedHostHelper />
          </p>
        </div>
        <div className="border-subtle rounded-b-md border border-t-0 px-6">
          <AddMembersWithSwitch
            groupId={null}
            teamMembers={teamMembers}
            value={value}
            onChange={onChange}
            assignAllTeamMembers={assignAllTeamMembers}
            setAssignAllTeamMembers={setAssignAllTeamMembers}
            automaticAddAllEnabled={true}
            isFixed={true}
            onActive={handleFixedHostsActivation}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-lg">
      <SettingsToggle
        data-testid="fixed-hosts-switch"
        toggleSwitchAtTheEnd={true}
        title={t("fixed_hosts")}
        description={<FixedHostHelper />}
        checked={isFixedHostsEnabled && !assignAllTeamMembers}
        hideSwitch={assignAllTeamMembers}
        labelClassName="text-sm"
        descriptionClassName="text-sm text-subtle"
        onCheckedChange={handleFixedHostsToggle}
        childrenClassName="lg:ml-0">
        <div className="border-subtle flex flex-col gap-6 rounded-bl-md rounded-br-md border border-t-0 px-6">
          <AddMembersWithSwitch
            data-testid="fixed-hosts-select"
            groupId={null}
            placeholder={t("add_a_member")}
            teamMembers={teamMembers}
            value={value}
            onChange={onChange}
            assignAllTeamMembers={assignAllTeamMembers}
            setAssignAllTeamMembers={setAssignAllTeamMembers}
            automaticAddAllEnabled={false}
            isFixed={true}
            onActive={handleFixedHostsActivation}
          />
        </div>
      </SettingsToggle>
    </div>
  );
};

type RoundRobinMembersSelectProps = {
  groupId: string | null;
  teamMembers: TeamMember[];
  value: Host[];
  onChange: (hosts: Host[]) => void;
  assignAllTeamMembers: boolean;
  setAssignAllTeamMembers: Dispatch<SetStateAction<boolean>>;
  isRRWeightsEnabled: boolean;
};

const RoundRobinMembersSelect = ({
  groupId,
  teamMembers,
  value,
  onChange,
  assignAllTeamMembers,
  setAssignAllTeamMembers,
  isRRWeightsEnabled,
}: RoundRobinMembersSelectProps) => {
  const { t } = useLocale();
  const { getValues, setValue } = useFormContext<FormValues>();

  const handleMembersActivation = useCallback(() => {
    setValue(
      "hosts",
      buildHostsForAllMembers({
        teamMembers,
        currentHosts: getValues("hosts"),
        isFixed: false,
        groupId,
      }),
      { shouldDirty: true }
    );
  }, [getValues, setValue, teamMembers, groupId]);

  return (
    <AddMembersWithSwitch
      placeholder={t("add_a_member")}
      teamMembers={teamMembers}
      value={value}
      onChange={onChange}
      assignAllTeamMembers={assignAllTeamMembers}
      setAssignAllTeamMembers={setAssignAllTeamMembers}
      automaticAddAllEnabled={true}
      isRRWeightsEnabled={isRRWeightsEnabled}
      isFixed={false}
      groupId={groupId}
      containerClassName={assignAllTeamMembers ? "-mt-4" : ""}
      onActive={handleMembersActivation}
    />
  );
};

const RoundRobinHosts = ({
  teamMembers,
  value,
  onChange,
  assignAllTeamMembers,
  setAssignAllTeamMembers,
}: {
  value: Host[];
  onChange: (hosts: Host[]) => void;
  teamMembers: TeamMember[];
  assignAllTeamMembers: boolean;
  setAssignAllTeamMembers: Dispatch<SetStateAction<boolean>>;
}) => {
  const { t } = useLocale();
  const { setValue, getValues, control } = useFormContext<FormValues>();
  const isRRWeightsEnabled = useWatch({ control, name: "isRRWeightsEnabled" });
  const hostGroups = useWatch({ control, name: "hostGroups" }) ?? [];

  const handleWeightsEnabledChange = (active: boolean, onWeightsChange: (value: boolean) => void) => {
    onWeightsChange(active);
    setValue("hosts", sortRoundRobinHosts(getValues("hosts"), active));
  };

  const handleAddGroup = () => {
    const updated = addHostGroup({ hosts: getValues("hosts"), hostGroups, newId: uuidv4 });
    setValue("hostGroups", updated.hostGroups, { shouldDirty: true });
    setValue("hosts", updated.hosts, { shouldDirty: true });

    // Assigning all members is incompatible with splitting hosts into groups.
    if (assignAllTeamMembers) {
      setValue("assignAllTeamMembers", false, { shouldDirty: true });
      setAssignAllTeamMembers(false);
    }
  };

  const handleGroupNameChange = (groupId: string, name: string) => {
    setValue(
      "hostGroups",
      hostGroups.map((group) => (group.id === groupId ? { ...group, name } : group)),
      { shouldDirty: true }
    );
  };

  const handleRemoveGroup = (groupId: string) => {
    const updated = removeHostGroup({ hosts: value, hostGroups, groupId });
    setValue("hostGroups", updated.hostGroups, { shouldDirty: true });
    onChange(updated.hosts);
    setValue("hosts", updated.hosts, { shouldDirty: true });
  };

  const membersSelectProps = {
    teamMembers,
    value,
    onChange,
    assignAllTeamMembers,
    setAssignAllTeamMembers,
    isRRWeightsEnabled,
  };
  const hasUnassignedHosts = value.some((host) => !host.isFixed && !host.groupId);

  return (
    <div className="rounded-lg" data-testid="rr-hosts-section">
      <div className="border-subtle mt-5 rounded-t-md border p-6 pb-5">
        <div className="flex items-center justify-between">
          <div>
            <Label className="mb-1 text-sm font-semibold">{t("round_robin_hosts")}</Label>
            <p className="text-subtle wrap-break-word max-w-full text-sm leading-tight">
              <LearnMoreLink
                t={t}
                i18nKey={hostGroups.length > 0 ? "round_robin_groups_helper" : "round_robin_helper"}
                href={ROUND_ROBIN_HELP_URL}
              />
            </p>
          </div>
          <Button
            color="secondary"
            size="sm"
            StartIcon="plus"
            data-testid="add-host-group"
            onClick={handleAddGroup}>
            {t("add_group")}
          </Button>
        </div>
      </div>
      <div className="border-subtle rounded-b-md border border-t-0 px-6 pt-4">
        <Controller<FormValues, "isRRWeightsEnabled">
          name="isRRWeightsEnabled"
          render={({ field: { value: weightsEnabled, onChange: onWeightsChange } }) => (
            <SettingsToggle
              title={t("enable_weights")}
              description={<LearnMoreLink t={t} i18nKey="weights_description" href={ROUND_ROBIN_HELP_URL} />}
              checked={weightsEnabled}
              onCheckedChange={(active) => handleWeightsEnabledChange(active, onWeightsChange)}
            />
          )}
        />
        {!hostGroups.length ? (
          <RoundRobinMembersSelect groupId={null} {...membersSelectProps} />
        ) : (
          <>
            {hasUnassignedHosts && (
              <div className="border-subtle my-4 rounded-md border p-4 pb-0">
                <div className="-mb-4 flex items-center justify-between">
                  <span className="text-default text-sm font-medium">
                    {t("host_group_name_placeholder", { number: hostGroups.length + 1 })}
                  </span>
                </div>
                <RoundRobinMembersSelect groupId={null} {...membersSelectProps} />
              </div>
            )}
            {hostGroups.map((group, index) => (
              <div key={group.id} className="border-subtle my-4 rounded-md border p-4 pb-0">
                <div className="-mb-4 flex items-center justify-between">
                  <input
                    type="text"
                    value={group.name ?? ""}
                    onChange={(e) => handleGroupNameChange(group.id, e.target.value)}
                    className="border-none bg-transparent p-0 text-sm font-medium focus:outline-none focus:ring-0"
                    placeholder={t("host_group_name_placeholder", { number: index + 1 })}
                  />
                  <button
                    type="button"
                    aria-label={t("remove_host_group")}
                    onClick={() => handleRemoveGroup(group.id)}
                    className="text-subtle hover:text-default rounded p-1">
                    <Icon name="x" className="h-4 w-4" />
                  </button>
                </div>
                <RoundRobinMembersSelect groupId={group.id} {...membersSelectProps} />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

const ChildrenEventTypes = ({
  childrenEventTypeOptions,
  assignAllTeamMembers,
  setAssignAllTeamMembers,
}: {
  childrenEventTypeOptions: ChildrenOption[];
  assignAllTeamMembers: boolean;
  setAssignAllTeamMembers: Dispatch<SetStateAction<boolean>>;
}) => {
  const { setValue } = useFormContext<FormValues>();
  return (
    <div className="border-subtle stack-y-5 mt-6 rounded-lg border px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-4">
        <AssignAllTeamMembers
          assignAllTeamMembers={assignAllTeamMembers}
          setAssignAllTeamMembers={setAssignAllTeamMembers}
          onActive={() => setValue("children", childrenEventTypeOptions, { shouldDirty: true })}
        />
        {!assignAllTeamMembers && (
          <Controller<FormValues, "children">
            name="children"
            render={({ field: { onChange, value } }) => (
              <ChildrenEventTypesList value={value} options={childrenEventTypeOptions} onChange={onChange} />
            )}
          />
        )}
      </div>
    </div>
  );
};

const Hosts = ({
  teamMembers,
  assignAllTeamMembers,
  setAssignAllTeamMembers,
}: {
  teamMembers: TeamMember[];
  assignAllTeamMembers: boolean;
  setAssignAllTeamMembers: Dispatch<SetStateAction<boolean>>;
}) => {
  const {
    control,
    setValue,
    getValues,
    formState: { submitCount },
  } = useFormContext<FormValues>();
  const schedulingType = useWatch({ control, name: "schedulingType" });
  const initialValue = useRef<{
    hosts: FormValues["hosts"];
    schedulingType: SchedulingType | null;
    submitCount: number;
  } | null>(null);

  useEffect(() => {
    // The snapshot is retaken after each submit so that switching back to the saved type restores
    // the saved hosts instead of the ones loaded before the last save.
    if (!initialValue.current || initialValue.current.submitCount !== submitCount) {
      initialValue.current = { hosts: getValues("hosts"), schedulingType, submitCount };
      return;
    }
    setValue(
      "hosts",
      initialValue.current.schedulingType === schedulingType ? initialValue.current.hosts : [],
      { shouldDirty: true }
    );
  }, [schedulingType, setValue, getValues, submitCount]);

  return (
    <Controller<FormValues, "hosts">
      name="hosts"
      render={({ field: { onChange, value } }) => {
        if (schedulingType === SchedulingType.COLLECTIVE) {
          return (
            <FixedHosts
              teamMembers={teamMembers}
              value={value}
              onChange={(changed) => onChange(mergeHostsPreservingMeta(changed, getValues("hosts")))}
              assignAllTeamMembers={assignAllTeamMembers}
              setAssignAllTeamMembers={setAssignAllTeamMembers}
            />
          );
        }
        if (schedulingType === SchedulingType.ROUND_ROBIN) {
          return (
            <>
              <FixedHosts
                teamMembers={teamMembers}
                value={value}
                onChange={(changed) =>
                  onChange(replaceHostsOfKind({ all: getValues("hosts"), changed, isFixed: true }))
                }
                assignAllTeamMembers={assignAllTeamMembers}
                setAssignAllTeamMembers={setAssignAllTeamMembers}
                isRoundRobinEvent={true}
              />
              <RoundRobinHosts
                teamMembers={teamMembers}
                value={value}
                onChange={(changed) =>
                  onChange(replaceHostsOfKind({ all: getValues("hosts"), changed, isFixed: false }))
                }
                assignAllTeamMembers={assignAllTeamMembers}
                setAssignAllTeamMembers={setAssignAllTeamMembers}
              />
            </>
          );
        }
        return <></>;
      }}
    />
  );
};

export const EventTeamAssignmentTab = ({ team, teamMembers, eventType }: EventTeamAssignmentTabProps) => {
  const { t } = useLocale();
  const { getValues, setValue, control } = useFormContext<FormValues>();
  const [assignAllTeamMembers, setAssignAllTeamMembers] = useState<boolean>(
    getValues("assignAllTeamMembers") ?? false
  );
  const schedulingType = useWatch({ control, name: "schedulingType" });

  const schedulingTypeOptions: { value: SchedulingType; label: string }[] = [
    { value: SchedulingType.COLLECTIVE, label: t("collective") },
    { value: SchedulingType.ROUND_ROBIN, label: t("round_robin") },
  ];

  const isOrgTeamEvent = !!eventType.team?.parentId;
  const isManagedEventType = eventType.schedulingType === SchedulingType.MANAGED;

  const teamMembersOptions = useMemo(
    () =>
      teamMembers
        .filter((member) => isAssignableMember(member, isOrgTeamEvent))
        .map((member) => mapUserToValue(member, t("pending"))),
    [teamMembers, isOrgTeamEvent, t]
  );

  const childrenEventTypeOptions = useMemo(() => {
    const ownersWithChild = new Set(eventType.children.map((child) => child.owner.id));
    return teamMembers
      .filter((member) => isAssignableMember(member, isOrgTeamEvent))
      .map((member) =>
        mapMemberToChildrenOption(
          {
            ...member,
            eventTypes: member.eventTypes.filter(
              (slug) => slug !== eventType.slug || !ownersWithChild.has(member.id)
            ),
          },
          eventType.slug,
          t("pending")
        )
      );
  }, [teamMembers, isOrgTeamEvent, eventType.children, eventType.slug, t]);

  const handleSchedulingTypeChange = (
    newSchedulingType: SchedulingType | undefined,
    onChange: (value: SchedulingType) => void
  ) => {
    if (!newSchedulingType) return;
    onChange(newSchedulingType);
    setValue("assignAllTeamMembers", false, { shouldDirty: true });
    setAssignAllTeamMembers(false);
  };

  if (!team) return <div />;

  if (isManagedEventType) {
    return (
      <div>
        <ChildrenEventTypes
          assignAllTeamMembers={assignAllTeamMembers}
          setAssignAllTeamMembers={setAssignAllTeamMembers}
          childrenEventTypeOptions={childrenEventTypeOptions}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="border-subtle flex flex-col rounded-md">
        <div className="border-subtle rounded-t-md border p-6 pb-5">
          <Label className="mb-1 text-sm font-semibold">{t("assignment")}</Label>
          <p className="text-subtle wrap-break-word max-w-full text-sm leading-tight">
            {t("assignment_description")}
          </p>
        </div>
        <div className="border-subtle rounded-b-md border border-t-0 p-6">
          <Label>{t("scheduling_type")}</Label>
          <Controller<FormValues, "schedulingType">
            name="schedulingType"
            render={({ field: { value, onChange } }) => (
              <Select
                data-testid="assignment-scheduling-type"
                options={schedulingTypeOptions}
                value={schedulingTypeOptions.find((option) => option.value === value)}
                className="w-full"
                onChange={(option) => handleSchedulingTypeChange(option?.value, onChange)}
              />
            )}
          />
        </div>
      </div>
      {schedulingType === SchedulingType.ROUND_ROBIN && (
        <div className="border-subtle mt-4 rounded-md border p-6">
          <Controller<FormValues, "includeNoShowInRRCalculation">
            name="includeNoShowInRRCalculation"
            render={({ field: { value, onChange } }) => (
              <SettingsToggle
                title={t("include_no_show_in_rr_calculation")}
                labelClassName="mt-1.5"
                checked={!!value}
                onCheckedChange={(checked) => onChange(checked)}
              />
            )}
          />
        </div>
      )}
      <Hosts
        assignAllTeamMembers={assignAllTeamMembers}
        setAssignAllTeamMembers={setAssignAllTeamMembers}
        teamMembers={teamMembersOptions}
      />
    </div>
  );
};

export default EventTeamAssignmentTab;
