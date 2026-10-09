import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingEventHandlerService,
  type NotetakerChoiceServiceAccessor,
} from "./BookingEventHandlerService";
import type { BookingCreatedPayload, BookingRescheduledPayload } from "./types";

function createLog() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function createHashedLinkService() {
  return { validateAndIncrementUsage: vi.fn().mockResolvedValue(undefined) };
}

function createNotetakerChoiceService() {
  return {
    onBookingCreated: vi.fn().mockResolvedValue(undefined),
    onBookingRescheduled: vi.fn().mockResolvedValue(undefined),
    onRecurringOccurrenceCreated: vi.fn().mockResolvedValue(undefined),
  };
}

type PayloadOverrides = { isDryRun?: boolean; hashedLink?: string | null };

function buildCreatedPayload(overrides: PayloadOverrides = {}): BookingCreatedPayload {
  return {
    config: { isDryRun: overrides.isDryRun ?? false },
    bookingFormData: {
      hashedLink: overrides.hashedLink === undefined ? "hashed-link-1" : overrides.hashedLink,
    },
    booking: {
      uid: "booking-uid-1",
      startTime: new Date("2026-01-10T10:00:00.000Z"),
      endTime: new Date("2026-01-10T10:30:00.000Z"),
      status: "ACCEPTED",
      userId: 7,
    },
  };
}

function buildRescheduledPayload(overrides: PayloadOverrides = {}): BookingRescheduledPayload {
  return {
    ...buildCreatedPayload(overrides),
    oldBooking: {
      uid: "old-booking-uid-1",
      startTime: new Date("2026-01-09T10:00:00.000Z"),
      endTime: new Date("2026-01-09T10:30:00.000Z"),
    },
  };
}

function setup(options: { withNotetaker?: boolean } = {}) {
  const log = createLog();
  const hashedLinkService = createHashedLinkService();
  const notetakerChoiceService = createNotetakerChoiceService();
  const getNotetakerChoiceService = vi
    .fn<NotetakerChoiceServiceAccessor>()
    .mockResolvedValue(notetakerChoiceService);
  const service =
    options.withNotetaker === false
      ? new BookingEventHandlerService({ log, hashedLinkService })
      : new BookingEventHandlerService({ log, hashedLinkService, getNotetakerChoiceService });
  return { log, hashedLinkService, notetakerChoiceService, getNotetakerChoiceService, service };
}

describe("BookingEventHandlerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("onBookingCreated", () => {
    it("applies the notetaker choice and updates the hashed link usage", async () => {
      const { service, notetakerChoiceService, hashedLinkService, log } = setup();

      await service.onBookingCreated({ payload: buildCreatedPayload() });

      expect(notetakerChoiceService.onBookingCreated).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onBookingCreated).toHaveBeenCalledWith({ bookingUid: "booking-uid-1" });
      expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledTimes(1);
      expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledWith("hashed-link-1");
      expect(notetakerChoiceService.onBookingRescheduled).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onRecurringOccurrenceCreated).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    });

    it("still applies the notetaker choice when there is no hashed link", async () => {
      const { service, notetakerChoiceService, hashedLinkService } = setup();

      await service.onBookingCreated({ payload: buildCreatedPayload({ hashedLink: null }) });

      expect(hashedLinkService.validateAndIncrementUsage).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingCreated).toHaveBeenCalledTimes(1);
    });

    it("does nothing on a dry run", async () => {
      const { service, notetakerChoiceService, getNotetakerChoiceService, hashedLinkService } = setup();

      await expect(
        service.onBookingCreated({ payload: buildCreatedPayload({ isDryRun: true }) })
      ).resolves.toBeUndefined();

      expect(getNotetakerChoiceService).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingCreated).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingRescheduled).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onRecurringOccurrenceCreated).not.toHaveBeenCalled();
      expect(hashedLinkService.validateAndIncrementUsage).not.toHaveBeenCalled();
    });

    it("logs and swallows a notetaker failure without skipping the hashed link update", async () => {
      const { service, notetakerChoiceService, hashedLinkService, log } = setup();
      notetakerChoiceService.onBookingCreated.mockRejectedValue(new Error("notetaker down"));

      await expect(service.onBookingCreated({ payload: buildCreatedPayload() })).resolves.toBeUndefined();

      expect(log.error).toHaveBeenCalledWith("Error while applying the notetaker choice", expect.anything());
      expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledTimes(1);
    });

    it("logs a hashed link failure without skipping the notetaker choice", async () => {
      const { service, notetakerChoiceService, hashedLinkService, log } = setup();
      hashedLinkService.validateAndIncrementUsage.mockRejectedValue(new Error("link expired"));

      await expect(service.onBookingCreated({ payload: buildCreatedPayload() })).resolves.toBeUndefined();

      expect(log.error).toHaveBeenCalledWith("Error while updating hashed link", expect.anything());
      expect(notetakerChoiceService.onBookingCreated).toHaveBeenCalledTimes(1);
    });
  });

  describe("onBookingRescheduled", () => {
    it("carries the notetaker choice from the old booking and updates the hashed link usage", async () => {
      const { service, notetakerChoiceService, hashedLinkService } = setup();

      await service.onBookingRescheduled({ payload: buildRescheduledPayload() });

      expect(notetakerChoiceService.onBookingRescheduled).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onBookingRescheduled).toHaveBeenCalledWith({
        bookingUid: "booking-uid-1",
        oldBookingUid: "old-booking-uid-1",
      });
      expect(notetakerChoiceService.onBookingCreated).not.toHaveBeenCalled();
      expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledTimes(1);
      expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledWith("hashed-link-1");
    });

    it("does nothing on a dry run", async () => {
      const { service, notetakerChoiceService, getNotetakerChoiceService, hashedLinkService } = setup();

      await expect(
        service.onBookingRescheduled({ payload: buildRescheduledPayload({ isDryRun: true }) })
      ).resolves.toBeUndefined();

      expect(getNotetakerChoiceService).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingCreated).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingRescheduled).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onRecurringOccurrenceCreated).not.toHaveBeenCalled();
      expect(hashedLinkService.validateAndIncrementUsage).not.toHaveBeenCalled();
    });

    it("logs and swallows a notetaker failure without skipping the hashed link update", async () => {
      const { service, notetakerChoiceService, hashedLinkService, log } = setup();
      notetakerChoiceService.onBookingRescheduled.mockRejectedValue(new Error("notetaker down"));

      await expect(
        service.onBookingRescheduled({ payload: buildRescheduledPayload() })
      ).resolves.toBeUndefined();

      expect(log.error).toHaveBeenCalledWith("Error while applying the notetaker choice", expect.anything());
      expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe("onRecurringOccurrenceCreated", () => {
    it("applies only the notetaker default, leaving the hashed link alone", async () => {
      const { service, notetakerChoiceService, hashedLinkService } = setup();

      await service.onRecurringOccurrenceCreated({ payload: buildCreatedPayload() });

      expect(notetakerChoiceService.onRecurringOccurrenceCreated).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onRecurringOccurrenceCreated).toHaveBeenCalledWith({
        bookingUid: "booking-uid-1",
      });
      expect(notetakerChoiceService.onBookingCreated).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingRescheduled).not.toHaveBeenCalled();
      expect(hashedLinkService.validateAndIncrementUsage).not.toHaveBeenCalled();
    });

    it("does nothing on a dry run", async () => {
      const { service, notetakerChoiceService, getNotetakerChoiceService, hashedLinkService } = setup();

      await expect(
        service.onRecurringOccurrenceCreated({ payload: buildCreatedPayload({ isDryRun: true }) })
      ).resolves.toBeUndefined();

      expect(getNotetakerChoiceService).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingCreated).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingRescheduled).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onRecurringOccurrenceCreated).not.toHaveBeenCalled();
      expect(hashedLinkService.validateAndIncrementUsage).not.toHaveBeenCalled();
    });

    it("logs and swallows a notetaker failure", async () => {
      const { service, notetakerChoiceService, log } = setup();
      notetakerChoiceService.onRecurringOccurrenceCreated.mockRejectedValue(new Error("notetaker down"));

      await expect(
        service.onRecurringOccurrenceCreated({ payload: buildCreatedPayload() })
      ).resolves.toBeUndefined();

      expect(log.error).toHaveBeenCalledWith(
        "Error while applying the notetaker default to a recurring occurrence",
        expect.anything()
      );
    });
  });

  describe("notetaker choice service accessor", () => {
    it("does not call the accessor when constructed", () => {
      const { getNotetakerChoiceService } = setup();

      expect(getNotetakerChoiceService).not.toHaveBeenCalled();
    });

    it("resolves the accessor once and applies the choice on booking created", async () => {
      const { service, notetakerChoiceService, getNotetakerChoiceService } = setup();

      await service.onBookingCreated({ payload: buildCreatedPayload() });

      expect(getNotetakerChoiceService).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onBookingCreated).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onBookingCreated).toHaveBeenCalledWith({ bookingUid: "booking-uid-1" });
    });

    it("resolves the accessor once and applies the choice on booking rescheduled", async () => {
      const { service, notetakerChoiceService, getNotetakerChoiceService } = setup();

      await service.onBookingRescheduled({ payload: buildRescheduledPayload() });

      expect(getNotetakerChoiceService).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onBookingRescheduled).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onBookingRescheduled).toHaveBeenCalledWith({
        bookingUid: "booking-uid-1",
        oldBookingUid: "old-booking-uid-1",
      });
    });

    it("resolves the accessor once and applies the default on a recurring occurrence", async () => {
      const { service, notetakerChoiceService, getNotetakerChoiceService } = setup();

      await service.onRecurringOccurrenceCreated({ payload: buildCreatedPayload() });

      expect(getNotetakerChoiceService).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onRecurringOccurrenceCreated).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onRecurringOccurrenceCreated).toHaveBeenCalledWith({
        bookingUid: "booking-uid-1",
      });
    });

    it("accepts an accessor that returns the service synchronously", async () => {
      const log = createLog();
      const hashedLinkService = createHashedLinkService();
      const notetakerChoiceService = createNotetakerChoiceService();
      const getNotetakerChoiceService = vi.fn(() => notetakerChoiceService);
      const service = new BookingEventHandlerService({ log, hashedLinkService, getNotetakerChoiceService });

      await service.onBookingCreated({ payload: buildCreatedPayload() });

      expect(getNotetakerChoiceService).toHaveBeenCalledTimes(1);
      expect(notetakerChoiceService.onBookingCreated).toHaveBeenCalledWith({ bookingUid: "booking-uid-1" });
      expect(log.error).not.toHaveBeenCalled();
    });

    describe("when the accessor rejects", () => {
      it("logs and swallows the failure on booking created without skipping the hashed link update", async () => {
        const { service, notetakerChoiceService, getNotetakerChoiceService, hashedLinkService, log } =
          setup();
        getNotetakerChoiceService.mockRejectedValue(new Error("config invalid"));

        await expect(service.onBookingCreated({ payload: buildCreatedPayload() })).resolves.toBeUndefined();

        expect(log.error).toHaveBeenCalledWith(
          "Error while applying the notetaker choice",
          expect.anything()
        );
        expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledTimes(1);
        expect(notetakerChoiceService.onBookingCreated).not.toHaveBeenCalled();
      });

      it("logs and swallows the failure on booking rescheduled without skipping the hashed link update", async () => {
        const { service, notetakerChoiceService, getNotetakerChoiceService, hashedLinkService, log } =
          setup();
        getNotetakerChoiceService.mockRejectedValue(new Error("config invalid"));

        await expect(
          service.onBookingRescheduled({ payload: buildRescheduledPayload() })
        ).resolves.toBeUndefined();

        expect(log.error).toHaveBeenCalledWith(
          "Error while applying the notetaker choice",
          expect.anything()
        );
        expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledTimes(1);
        expect(notetakerChoiceService.onBookingRescheduled).not.toHaveBeenCalled();
      });

      it("logs and swallows the failure on a recurring occurrence", async () => {
        const { service, notetakerChoiceService, getNotetakerChoiceService, log } = setup();
        getNotetakerChoiceService.mockRejectedValue(new Error("config invalid"));

        await expect(
          service.onRecurringOccurrenceCreated({ payload: buildCreatedPayload() })
        ).resolves.toBeUndefined();

        expect(log.error).toHaveBeenCalledWith(
          "Error while applying the notetaker default to a recurring occurrence",
          expect.anything()
        );
        expect(notetakerChoiceService.onRecurringOccurrenceCreated).not.toHaveBeenCalled();
      });
    });

    describe("when the accessor throws synchronously", () => {
      it("logs and swallows the failure on booking created without skipping the hashed link update", async () => {
        const { service, notetakerChoiceService, getNotetakerChoiceService, hashedLinkService, log } =
          setup();
        getNotetakerChoiceService.mockImplementation(() => {
          throw new Error("config invalid");
        });

        await expect(service.onBookingCreated({ payload: buildCreatedPayload() })).resolves.toBeUndefined();

        expect(log.error).toHaveBeenCalledWith(
          "Error while applying the notetaker choice",
          expect.anything()
        );
        expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledTimes(1);
        expect(notetakerChoiceService.onBookingCreated).not.toHaveBeenCalled();
      });
    });
  });

  describe("without a notetaker choice service accessor", () => {
    it("keeps the hashed link behaviour and logs no error", async () => {
      const { service, hashedLinkService, notetakerChoiceService, log } = setup({ withNotetaker: false });

      await expect(service.onBookingCreated({ payload: buildCreatedPayload() })).resolves.toBeUndefined();
      await expect(
        service.onBookingRescheduled({ payload: buildRescheduledPayload() })
      ).resolves.toBeUndefined();
      await expect(
        service.onRecurringOccurrenceCreated({ payload: buildCreatedPayload() })
      ).resolves.toBeUndefined();

      expect(hashedLinkService.validateAndIncrementUsage).toHaveBeenCalledTimes(2);
      expect(log.error).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingCreated).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onBookingRescheduled).not.toHaveBeenCalled();
      expect(notetakerChoiceService.onRecurringOccurrenceCreated).not.toHaveBeenCalled();
    });
  });
});
