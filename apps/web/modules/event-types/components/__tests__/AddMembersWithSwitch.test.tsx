import type { Host, TeamMember } from "@calcom/features/eventtypes/lib/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import type { AddMembersWithSwitchProps } from "../AddMembersWithSwitch";
import { AddMembersWithSwitch } from "../AddMembersWithSwitch";

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [null],
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

const teamMembers: TeamMember[] = [
  { value: "2", label: "Jane Smith", avatar: "a2.jpg", email: "jane@example.com", defaultScheduleId: 5 },
  { value: "1", label: "John Doe", avatar: "a1.jpg", email: "john@example.com", defaultScheduleId: null },
];

function FormWrapper({ children }: { children: ReactNode }) {
  const methods = useForm({ defaultValues: { assignAllTeamMembers: false } });
  return <FormProvider {...methods}>{children}</FormProvider>;
}

function Harness(props: Partial<AddMembersWithSwitchProps>) {
  const [assignAll, setAssignAll] = useState(props.assignAllTeamMembers ?? false);
  return (
    <FormWrapper>
      <AddMembersWithSwitch
        teamMembers={teamMembers}
        value={[] as Host[]}
        onChange={vi.fn()}
        automaticAddAllEnabled
        onActive={vi.fn()}
        isFixed={false}
        groupId={null}
        data-testid="hosts-select"
        {...props}
        assignAllTeamMembers={assignAll}
        setAssignAllTeamMembers={setAssignAll}
      />
    </FormWrapper>
  );
}

describe("AddMembersWithSwitch", () => {
  it("shows the assign-all toggle only when enabled and there is no group", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByTestId("assign-all-team-members-toggle")).toBeInTheDocument();
    unmount();

    const { unmount: unmountGroup } = render(<Harness groupId="group-1" />);
    expect(screen.queryByTestId("assign-all-team-members-toggle")).not.toBeInTheDocument();
    unmountGroup();

    render(<Harness automaticAddAllEnabled={false} />);
    expect(screen.queryByTestId("assign-all-team-members-toggle")).not.toBeInTheDocument();
  });

  it("calls onActive when the toggle is switched on and hides the select", () => {
    const onActive = vi.fn();
    render(<Harness onActive={onActive} placeholder="pick members" />);
    expect(screen.getByText("pick members")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch"));

    expect(onActive).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("pick members")).not.toBeInTheDocument();
  });

  it("does not render the select when all team members are assigned", () => {
    render(<Harness assignAllTeamMembers placeholder="pick members" />);
    expect(screen.getByTestId("assign-all-team-members-toggle")).toBeInTheDocument();
    expect(screen.queryByText("pick members")).not.toBeInTheDocument();
  });

  it("calls onChange with a host built from the selected member", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} groupId="group-1" isFixed placeholder="pick members" />);

    fireEvent.keyDown(screen.getByText("pick members"), { key: "ArrowDown" });
    fireEvent.click(screen.getByText("Jane Smith"));

    expect(onChange).toHaveBeenCalledWith([
      { isFixed: true, userId: 2, priority: 2, weight: 100, scheduleId: 5, groupId: "group-1" },
    ]);
  });
});
