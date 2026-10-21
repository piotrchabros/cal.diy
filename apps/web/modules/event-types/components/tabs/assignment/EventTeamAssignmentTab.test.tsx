import type { FormValues, Host } from "@calcom/features/eventtypes/lib/types";
import { SchedulingType } from "@calcom/prisma/enums";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { FormProvider, type UseFormReturn, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { EventTeamAssignmentTab, type EventTeamAssignmentTabProps } from "./EventTeamAssignmentTab";

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [null],
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/event-types/1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

type TabMember = EventTeamAssignmentTabProps["teamMembers"][number];

const makeMember = (id: number, username: string | null): TabMember =>
  ({
    id,
    name: `Member ${id}`,
    username,
    avatar: `a${id}.jpg`,
    email: `m${id}@example.com`,
    defaultScheduleId: null,
    eventTypes: [],
    membership: "MEMBER",
    profileId: null,
    isPending: false,
    // The full member shape is far wider than what the tab reads.
  }) as unknown as TabMember;

const teamMembers: TabMember[] = [makeMember(1, "one"), makeMember(2, "two"), makeMember(3, null)];

const team = { id: 10 } as unknown as EventTeamAssignmentTabProps["team"];

const makeEventType = (schedulingType: SchedulingType): EventTeamAssignmentTabProps["eventType"] =>
  // Only team, slug, children and schedulingType are read; the full event type shape is impractical.
  ({
    schedulingType,
    slug: "event",
    team: { parentId: null },
    children: [],
  }) as unknown as EventTeamAssignmentTabProps["eventType"];

const existingHost: Host = {
  isFixed: false,
  userId: 1,
  priority: 2,
  weight: 100,
  scheduleId: null,
  groupId: null,
};

type FormDefaults = Pick<
  FormValues,
  "schedulingType" | "hosts" | "hostGroups" | "assignAllTeamMembers" | "isRRWeightsEnabled" | "children"
>;

const baseDefaults: FormDefaults = {
  schedulingType: SchedulingType.COLLECTIVE,
  hosts: [],
  hostGroups: [],
  assignAllTeamMembers: false,
  isRRWeightsEnabled: false,
  children: [],
};

const captured: { current: UseFormReturn<FormValues> | null } = { current: null };

function Wrapper({ defaults, children }: { defaults: FormDefaults; children: ReactNode }): JSX.Element {
  const methods = useForm<FormValues>({ defaultValues: defaults });
  // Reading dirtyFields during render subscribes the form to dirty-state updates.
  void methods.formState.dirtyFields;
  captured.current = methods;
  return (
    <FormProvider {...methods}>
      <TooltipProvider>{children}</TooltipProvider>
    </FormProvider>
  );
}

function renderTab({
  overrides = {},
  team: teamProp = team,
  eventSchedulingType,
}: {
  overrides?: Partial<FormDefaults>;
  team?: EventTeamAssignmentTabProps["team"] | null;
  eventSchedulingType?: SchedulingType;
} = {}): ReturnType<typeof render> {
  const defaults = { ...baseDefaults, ...overrides };
  return render(
    <Wrapper defaults={defaults}>
      <EventTeamAssignmentTab
        team={teamProp as EventTeamAssignmentTabProps["team"]}
        teamMembers={teamMembers}
        eventType={makeEventType(eventSchedulingType ?? defaults.schedulingType ?? SchedulingType.COLLECTIVE)}
      />
    </Wrapper>
  );
}

const getForm = (): UseFormReturn<FormValues> => captured.current as UseFormReturn<FormValues>;

describe("EventTeamAssignmentTab", () => {
  it("renders nothing meaningful when there is no team", () => {
    const { container } = renderTab({ team: null });
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("assignment-scheduling-type")).not.toBeInTheDocument();
  });

  it("shows the fixed hosts section for collective events without round robin hosts", () => {
    renderTab();
    expect(screen.getByText("fixed_hosts")).toBeInTheDocument();
    expect(screen.getByTestId("assign-all-team-members-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("rr-hosts-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fixed-hosts-switch")).not.toBeInTheDocument();
  });

  it("shows fixed hosts switch, round robin section and weights toggle for round robin events", () => {
    renderTab({ overrides: { schedulingType: SchedulingType.ROUND_ROBIN } });
    expect(screen.getByTestId("fixed-hosts-switch")).toBeInTheDocument();
    const rrSection = screen.getByTestId("rr-hosts-section");
    expect(within(rrSection).getByText("enable_weights")).toBeInTheDocument();
    expect(screen.getByTestId("add-host-group")).toBeInTheDocument();
  });

  it("clears hosts and assignAllTeamMembers when the scheduling type changes", () => {
    renderTab({ overrides: { hosts: [existingHost], assignAllTeamMembers: true } });

    const select = screen.getByTestId("assignment-scheduling-type");
    const input = within(select).getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.click(screen.getByText("round_robin"));

    expect(getForm().getValues("schedulingType")).toBe(SchedulingType.ROUND_ROBIN);
    expect(getForm().getValues("hosts")).toEqual([]);
    expect(getForm().getValues("assignAllTeamMembers")).toBe(false);
    expect(getForm().formState.dirtyFields.hosts).toBeTruthy();
    expect(getForm().formState.dirtyFields.assignAllTeamMembers).toBe(true);
  });

  it("fills hosts with every assignable member when assign all is turned on", () => {
    renderTab();
    fireEvent.click(screen.getByTestId("assign-all-team-members-toggle"));

    expect(getForm().getValues("assignAllTeamMembers")).toBe(true);
    const hosts = getForm().getValues("hosts");
    expect(hosts.map((host) => host.userId).sort()).toEqual([1, 2]);
    expect(hosts.every((host) => host.isFixed)).toBe(true);
  });

  it("adds and removes a host group", () => {
    // Adding the first group splits existing round robin hosts into two groups.
    renderTab({ overrides: { schedulingType: SchedulingType.ROUND_ROBIN, hosts: [existingHost] } });

    fireEvent.click(screen.getByTestId("add-host-group"));
    expect(getForm().getValues("hostGroups")).toHaveLength(2);

    fireEvent.click(screen.getAllByLabelText("remove_host_group")[0]);
    expect(getForm().getValues("hostGroups")).toHaveLength(1);
  });

  it("renders the children select instead of the scheduling type select for managed event types", () => {
    renderTab({ overrides: { schedulingType: SchedulingType.MANAGED } });
    expect(screen.getByTestId("assign-all-team-members-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("assignment-dropdown")).toBeInTheDocument();
    expect(screen.queryByTestId("assignment-scheduling-type")).not.toBeInTheDocument();
  });
});
