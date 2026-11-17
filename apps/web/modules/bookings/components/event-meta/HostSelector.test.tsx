import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostSelector } from "./HostSelector";

const state = {
  selectedHostIds: null as number[] | null,
  setSelectedHostIds: vi.fn(),
  setSelectedTimeslot: vi.fn(),
};

vi.mock("@calcom/features/bookings/Booker/BookerStoreProvider", () => ({
  useBookerStoreContext: (selector: (s: typeof state) => unknown) => selector(state),
}));
vi.mock("@calcom/lib/hooks/useLocale", () => ({ useLocale: () => ({ t: (key: string) => key }) }));

const hosts = [
  { id: 1, name: "Alice", username: "alice", avatarUrl: "" },
  { id: 2, name: null, username: "bob", avatarUrl: "" },
  { id: 3, name: "Carol", username: "carol", avatarUrl: "" },
];

describe("HostSelector", () => {
  beforeEach(() => {
    state.selectedHostIds = null;
    state.setSelectedHostIds.mockClear();
    state.setSelectedTimeslot.mockClear();
  });

  it("checks every host by default and falls back to username", () => {
    render(<HostSelector hosts={hosts} />);
    expect(screen.getByText("choose_who_attends")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("stores the remaining ids in host order when unchecking and clears the timeslot", () => {
    render(<HostSelector hosts={hosts} />);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(state.setSelectedHostIds).toHaveBeenCalledWith([1, 3]);
    expect(state.setSelectedTimeslot).toHaveBeenCalledWith(null);
  });

  it("resets to null when everyone is checked again", () => {
    state.selectedHostIds = [1, 3];
    render(<HostSelector hosts={hosts} />);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(state.setSelectedHostIds).toHaveBeenCalledWith(null);
  });

  it("keeps host order when re-adding a host to a subset", () => {
    state.selectedHostIds = [3];
    render(<HostSelector hosts={hosts} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(state.setSelectedHostIds).toHaveBeenCalledWith([1, 3]);
  });

  it("does not allow unchecking the last host", () => {
    state.selectedHostIds = [2];
    render(<HostSelector hosts={hosts} />);
    const [first, second] = screen.getAllByRole("checkbox");
    expect((second as HTMLButtonElement).disabled).toBe(true);
    expect(second.getAttribute("title")).toBe("at_least_one_member_required");
    expect((first as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(second);
    expect(state.setSelectedHostIds).not.toHaveBeenCalled();
  });
});
