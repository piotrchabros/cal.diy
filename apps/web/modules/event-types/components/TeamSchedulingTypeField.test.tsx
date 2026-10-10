import type { createEventTypeInput } from "@calcom/features/eventtypes/lib/types";
import { SchedulingType } from "@calcom/prisma/enums";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { UseFormReturn } from "react-hook-form";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { TeamSchedulingTypeField } from "./TeamSchedulingTypeField";

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

type FormValues = z.infer<typeof createEventTypeInput>;

let currentForm: UseFormReturn<FormValues> | undefined;

function Harness({ teamId }: { teamId: number }) {
  const form = useForm<FormValues>({
    defaultValues: { title: "", slug: "", length: 15 },
  });
  currentForm = form;
  return <TeamSchedulingTypeField form={form} teamId={teamId} />;
}

describe("TeamSchedulingTypeField", () => {
  it("sets teamId and defaults to collective on mount", () => {
    render(<Harness teamId={7} />);

    expect(currentForm?.getValues("teamId")).toBe(7);
    expect(currentForm?.getValues("schedulingType")).toBe(SchedulingType.COLLECTIVE);
  });

  it("switches to round robin when that option is clicked", () => {
    render(<Harness teamId={7} />);

    fireEvent.click(screen.getByTestId("scheduling-type-round-robin"));

    expect(currentForm?.getValues("schedulingType")).toBe(SchedulingType.ROUND_ROBIN);
  });

  it("does not offer the managed type", () => {
    render(<Harness teamId={7} />);

    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByText("managed_event")).toBeNull();
  });

  it("renders the host notice", () => {
    render(<Harness teamId={7} />);

    expect(screen.getByTestId("team-event-type-host-notice")).toHaveTextContent(
      "team_event_type_creator_is_host"
    );
  });

  it("clears teamId and schedulingType on unmount", () => {
    const { unmount } = render(<Harness teamId={7} />);

    act(() => unmount());

    expect(currentForm?.getValues("teamId")).toBeUndefined();
    expect(currentForm?.getValues("schedulingType")).toBeUndefined();
  });
});
