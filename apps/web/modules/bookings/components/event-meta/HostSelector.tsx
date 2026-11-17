import { useBookerStoreContext } from "@calcom/features/bookings/Booker/BookerStoreProvider";
import type { BookerEvent } from "@calcom/features/bookings/types";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Avatar } from "@calcom/ui/components/avatar";
import { Checkbox } from "@calcom/ui/components/form";
import { shallow } from "zustand/shallow";

type HostSelectorProps = {
  hosts: NonNullable<BookerEvent["selectableHosts"]>;
};

export const HostSelector = ({ hosts }: HostSelectorProps) => {
  const { t } = useLocale();
  const [selectedHostIds, setSelectedHostIds, setSelectedTimeslot] = useBookerStoreContext(
    (state) => [state.selectedHostIds, state.setSelectedHostIds, state.setSelectedTimeslot],
    shallow
  );

  const checkedIds = new Set(selectedHostIds ?? hosts.map((host) => host.id));
  const isLastChecked = checkedIds.size <= 1;

  const toggleHost = (hostId: number) => {
    const next = hosts.filter((host) =>
      host.id === hostId ? !checkedIds.has(hostId) : checkedIds.has(host.id)
    );
    if (next.length === 0) return;

    setSelectedHostIds(next.length === hosts.length ? null : next.map((host) => host.id));
    // Previously picked slot may not be available for the new set of hosts.
    setSelectedTimeslot(null);
  };

  return (
    <div className="mb-2" data-testid="host-selector">
      <h3 className="text-emphasis mb-2 text-sm font-semibold">{t("choose_who_attends")}</h3>
      <ul className="stack-y-2">
        {hosts.map((host) => {
          const displayName = host.name ?? host.username ?? "";
          const isChecked = checkedIds.has(host.id);
          const isDisabled = isChecked && isLastChecked;
          const inputId = `host-selector-${host.id}`;
          return (
            <li key={host.id} className="flex items-center gap-2">
              <Checkbox
                id={inputId}
                checked={isChecked}
                disabled={isDisabled}
                title={isDisabled ? t("at_least_one_member_required") : undefined}
                onCheckedChange={() => toggleHost(host.id)}
              />
              <label htmlFor={inputId} className="flex cursor-pointer items-center gap-2 text-sm">
                <Avatar size="xsm" alt={displayName} imageSrc={host.avatarUrl} />
                <span className="text-default">{displayName}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
