import { OrgBaseUrlContext } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { WEBSITE_URL } from "@calcom/lib/constants";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSetupTabProps } from "./EventSetupTab";
import EventSetupTabWebWrapper from "./EventSetupTabWebWrapper";

const capturedProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("./EventSetupTab", () => ({
  EventSetupTab: (props: Record<string, unknown>) => {
    capturedProps.current = props;
    return null;
  },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
}));

vi.mock("@calcom/lib/i18n", () => ({ localeOptions: [] }));

const props = {} as EventSetupTabProps;

describe("EventSetupTabWebWrapper", () => {
  beforeEach(() => {
    capturedProps.current = null;
  });

  it("uses the organization host as urlPrefix on an organization host", () => {
    render(
      <OrgBaseUrlContext.Provider value={{ baseUrl: "https://acme.test", orgSlug: "acme" }}>
        <EventSetupTabWebWrapper {...props} />
      </OrgBaseUrlContext.Provider>
    );

    expect(capturedProps.current?.urlPrefix).toBe("acme.test");
  });

  it("keeps the WEBSITE_URL host as urlPrefix off an organization host", () => {
    render(<EventSetupTabWebWrapper {...props} />);

    expect(capturedProps.current?.urlPrefix).toBe(WEBSITE_URL.replace(/^(https?:|)\/\//, ""));
  });
});
