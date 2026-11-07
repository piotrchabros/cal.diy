import { WEBAPP_URL } from "@calcom/lib/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuildPaymentService } from "./PaymentService";

const { createOrder } = vi.hoisted(() => ({
  createOrder:
    vi.fn<
      (args: {
        referenceId: string;
        returnUrl: string;
        cancelUrl: string;
        intent?: "CAPTURE" | "AUTHORIZE";
      }) => Promise<{ id: string }>
    >(),
}));

vi.mock("@calcom/app-store/paypal/lib/Paypal", () => ({
  default: class {
    createOrder = createOrder;
  },
}));

vi.mock("@calcom/prisma", () => ({
  default: {
    booking: {
      findUnique: vi.fn(async () => ({ uid: "booking-uid", title: "Paid event" })),
    },
    payment: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 1, ...args.data })),
    },
  },
}));

const credentials = {
  key: { client_id: "client-id", secret_key: "secret-key", webhook_id: "webhook-id" },
};

const orderArgs = () => {
  const [args] = createOrder.mock.calls[0];
  return args;
};

describe("PaypalPaymentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOrder.mockResolvedValue({ id: "paypal-order-id" });
  });

  describe("create", () => {
    const create = (bookerUrl?: string) =>
      BuildPaymentService(credentials).create(
        { amount: 5000, currency: "USD" },
        1,
        101,
        "organizer",
        "Booker",
        "ON_BOOKING",
        "booker@example.com",
        null,
        "Paid event",
        "Paid event between Organizer and Booker",
        bookerUrl
      );

    it("returns the booker to the organization domain", async () => {
      await create("https://acme.example.org");

      const { referenceId, returnUrl, cancelUrl } = orderArgs();
      expect(returnUrl).toBe(
        "https://acme.example.org/api/integrations/paypal/capture?bookingUid=booking-uid"
      );
      expect(cancelUrl).toBe(`https://acme.example.org/payment/${referenceId}`);
    });

    it("falls back to WEBAPP_URL without a booker URL", async () => {
      await create();

      const { referenceId, returnUrl, cancelUrl } = orderArgs();
      expect(returnUrl).toBe(`${WEBAPP_URL}/api/integrations/paypal/capture?bookingUid=booking-uid`);
      expect(cancelUrl).toBe(`${WEBAPP_URL}/payment/${referenceId}`);
    });
  });

  describe("collectCard", () => {
    // PayPal's app metadata only offers ON_BOOKING, so HOLD never reaches createOrder.
    it.each(["HOLD", "ON_BOOKING"] as const)("never creates an order for %s", async (paymentOption) => {
      await expect(
        BuildPaymentService(credentials).collectCard(
          { amount: 5000, currency: "USD" },
          1,
          paymentOption,
          "booker@example.com",
          null,
          "https://acme.example.org"
        )
      ).rejects.toThrow();
      expect(createOrder).not.toHaveBeenCalled();
    });
  });
});
