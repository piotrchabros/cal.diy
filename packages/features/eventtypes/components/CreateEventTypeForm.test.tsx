import type { createEventTypeInput } from "@calcom/features/eventtypes/lib/types";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import CreateEventTypeForm from "./CreateEventTypeForm";

vi.mock("@calcom/atoms/hooks/useIsPlatform", () => ({
  useIsPlatform: () => false,
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/ui/components/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@calcom/ui/components/editor", () => ({
  Editor: () => <div data-testid="editor" />,
}));

function Harness({ withExtraFields }: { withExtraFields: boolean }) {
  const form = useForm<z.infer<typeof createEventTypeInput>>({
    defaultValues: { title: "", slug: "", length: 15 },
  });
  return (
    <CreateEventTypeForm
      form={form}
      isManagedEventType={false}
      handleSubmit={() => undefined}
      pageSlug="team/acme"
      isPending={false}
      urlPrefix="cal.example.com"
      SubmitButton={() => <button type="submit">continue</button>}
      extraFields={withExtraFields ? <div data-testid="extra-fields" /> : undefined}
    />
  );
}

describe("CreateEventTypeForm extraFields", () => {
  it("renders the extra fields after the duration field", () => {
    render(<Harness withExtraFields />);

    const extra = screen.getByTestId("extra-fields");
    const duration = screen.getByLabelText("duration");
    expect(duration.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders nothing extra when omitted", () => {
    render(<Harness withExtraFields={false} />);

    expect(screen.queryByTestId("extra-fields")).toBeNull();
    expect(screen.getByLabelText("duration")).toBeTruthy();
  });
});
