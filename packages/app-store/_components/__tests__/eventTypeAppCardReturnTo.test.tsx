import CloseComCard from "@calcom/app-store/closecom/components/EventTypeAppCardInterface";
import HitpayCard from "@calcom/app-store/hitpay/components/EventTypeAppCardInterface";
import HubspotCard from "@calcom/app-store/hubspot/components/EventTypeAppCardInterface";
import PaypalCard from "@calcom/app-store/paypal/components/EventTypeAppCardInterface";
import PipedriveCard from "@calcom/app-store/pipedrive-crm/components/EventTypeAppCardInterface";
import SalesforceCard from "@calcom/app-store/salesforce/components/EventTypeAppCardInterface";
import StripeCard from "@calcom/app-store/stripepayment/components/EventTypeAppCardInterface";
import type { EventTypeAppCardComponent, EventTypeAppCardComponentProps } from "@calcom/app-store/types";
import ZohoBiginCard from "@calcom/app-store/zoho-bigin/components/EventTypeAppCardInterface";
import ZohoCrmCard from "@calcom/app-store/zohocrm/components/EventTypeAppCardInterface";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const DEFAULT_WEBAPP_URL = "https://app.example.com";

vi.mock("@calcom/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/constants")>();
  return { ...actual, WEBAPP_URL: "https://app.example.com" };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/event-types/1",
  useSearchParams: () => new URLSearchParams("tabName=apps"),
}));

vi.mock("@calcom/app-store/_components/AppCard", () => ({
  default: ({ returnTo }: { returnTo?: string }) => <div data-testid="app-card" data-return-to={returnTo} />,
}));

vi.mock("@calcom/app-store/_utils/useIsAppEnabled", () => ({
  default: () => ({ enabled: false, updateEnabled: vi.fn() }),
}));

vi.mock("@calcom/app-store/EventTypeAppContext", () => ({
  useAppContextWithSchema: () => ({ getAppData: () => undefined, setAppData: vi.fn(), disabled: false }),
}));

vi.mock("@calcom/app-store/_utils/payments/checkForMultiplePaymentApps", () => ({
  default: () => false,
}));

const cards: [string, EventTypeAppCardComponent][] = [
  ["closecom", CloseComCard],
  ["hubspot", HubspotCard],
  ["pipedrive-crm", PipedriveCard],
  ["salesforce", SalesforceCard],
  ["zoho-bigin", ZohoBiginCard],
  ["zohocrm", ZohoCrmCard],
  ["stripepayment", StripeCard],
  ["hitpay", HitpayCard],
  ["paypal", PaypalCard],
];

describe("EventTypeAppCard returnTo", () => {
  it.each(cards)("%s sends the user back to the current origin, not WEBAPP_URL", (slug, Card) => {
    // The cards only read a handful of fields, so a partial fixture keeps the test focused on returnTo.
    const props = {
      app: { slug, name: slug, userCredentialIds: [], credentialOwner: null },
      eventType: { id: 1, schedulingType: null },
      eventTypeFormMetadata: {},
      onAppInstallSuccess: vi.fn(),
    } as unknown as EventTypeAppCardComponentProps;

    render(<Card {...props} />);

    const returnTo = screen.getByTestId("app-card").getAttribute("data-return-to");
    expect(returnTo).toBe(`${window.location.origin}/event-types/1?tabName=apps`);
    expect(returnTo?.startsWith(DEFAULT_WEBAPP_URL)).toBe(false);
  });
});
