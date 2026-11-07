import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { Payment } from "@calcom/prisma/client";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { AfterPaymentDeps } from "@calcom/types/PaymentService";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildPaymentService } from "./PaymentService";

const { findByIdIncludeUserAndAttendees, logError } = vi.hoisted(() => ({
  findByIdIncludeUserAndAttendees: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class StripeStub {},
}));

vi.mock("@calcom/prisma", () => ({
  default: {},
}));

vi.mock("@calcom/lib/logger", () => ({
  default: {
    getSubLogger: () => ({ error: logError, debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock("./repositories/PrismaBookingRepository", () => ({
  PrismaBookingRepository: class {
    findByIdIncludeUserAndAttendees = findByIdIncludeUserAndAttendees;
  },
}));

const buildService = () =>
  BuildPaymentService({
    key: { stripe_user_id: "acct_1", default_currency: "usd", stripe_publishable_key: "pk" },
  });

const booking = {
  user: { email: "organizer@example.com", name: "Organizer", timeZone: "UTC" },
  id: 1,
  startTime: new Date("2026-01-01T10:00:00.000Z"),
  uid: "booking-uid",
};

const paymentData = { id: 42 } as Payment;

const buildEvent = (attendeeSeatId?: string) => ({ attendeeSeatId }) as CalendarEvent;

const buildDeps = () => {
  const create = vi.fn<AfterPaymentDeps["tasker"]["create"]>().mockResolvedValue(undefined);
  const deps: AfterPaymentDeps = { tasker: { create } };
  return { deps, create };
};

describe("StripePaymentService", () => {
  const now = new Date("2026-01-01T09:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("afterPayment", () => {
    it("schedules the awaiting payment email through the injected tasker 15 minutes from now", async () => {
      const { deps, create } = buildDeps();

      await buildService().afterPayment(buildEvent(), booking, paymentData, undefined, deps);

      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(
        "sendAwaitingPaymentEmail",
        { bookingId: 1, paymentId: 42, attendeeSeatId: null },
        { scheduledAt: new Date(now.getTime() + 15 * 60 * 1000), referenceUid: "booking-uid" }
      );
    });

    it("respects AWAITING_PAYMENT_EMAIL_DELAY_MINUTES", async () => {
      vi.stubEnv("AWAITING_PAYMENT_EMAIL_DELAY_MINUTES", "30");
      const { deps, create } = buildDeps();

      await buildService().afterPayment(buildEvent(), booking, paymentData, undefined, deps);

      expect(create).toHaveBeenCalledWith(
        "sendAwaitingPaymentEmail",
        expect.any(Object),
        expect.objectContaining({ scheduledAt: new Date(now.getTime() + 30 * 60 * 1000) })
      );
    });

    it("passes the event attendeeSeatId through to the task payload", async () => {
      const { deps, create } = buildDeps();

      await buildService().afterPayment(buildEvent("seat-1"), booking, paymentData, undefined, deps);

      expect(create).toHaveBeenCalledWith(
        "sendAwaitingPaymentEmail",
        { bookingId: 1, paymentId: 42, attendeeSeatId: "seat-1" },
        expect.any(Object)
      );
    });
  });

  describe("chargeCard", () => {
    it("loads the booking through the repository and fails when it does not exist", async () => {
      findByIdIncludeUserAndAttendees.mockResolvedValue(null);

      const result = buildService().chargeCard(paymentData, 1);

      await expect(result).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(result).rejects.toMatchObject({
        code: ErrorCode.ChargeCardFailure,
        message: "could_not_charge_card",
      });
      expect(findByIdIncludeUserAndAttendees).toHaveBeenCalledWith(1);
      // chargeCard maps every failure to a generic user message, so the underlying cause only surfaces in the log
      expect(logError).toHaveBeenCalledWith(
        "Stripe: Could not charge card for payment",
        1,
        expect.stringContaining("Booking 1 not found")
      );
    });
  });
});
