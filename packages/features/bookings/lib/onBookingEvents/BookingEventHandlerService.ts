import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { HashedLinkService } from "@calcom/features/hashedLink/lib/service/HashedLinkService";
import type { NotetakerChoiceService } from "@calcom/features/notetaker/services/NotetakerChoiceService";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { BookingCreatedPayload, BookingRescheduledPayload } from "./types";

interface BookingEventHandlerDeps {
  log: ISimpleLogger;
  hashedLinkService: Pick<HashedLinkService, "validateAndIncrementUsage">;
  /**
   * Optional so callers that build the handler by hand (apps/api/v2's subclass) keep compiling and
   * behave as before. An accessor so nothing notetaker-related (config parsing included) is resolved
   * until a hook runs inside the handler's error isolation.
   */
  getNotetakerChoiceService?: NotetakerChoiceServiceAccessor;
}

interface OnBookingCreatedParams {
  payload: BookingCreatedPayload;
}

interface OnBookingRescheduledParams {
  payload: BookingRescheduledPayload;
}

interface OnRecurringOccurrenceCreatedParams {
  payload: BookingCreatedPayload;
}

export type NotetakerBookingHooks = Pick<
  NotetakerChoiceService,
  "onBookingCreated" | "onBookingRescheduled" | "onRecurringOccurrenceCreated"
>;

export type NotetakerChoiceServiceAccessor = () => NotetakerBookingHooks | Promise<NotetakerBookingHooks>;

export class BookingEventHandlerService {
  private readonly log: BookingEventHandlerDeps["log"];

  constructor(private readonly deps: BookingEventHandlerDeps) {
    this.log = deps.log;
  }

  async onBookingCreated(params: OnBookingCreatedParams) {
    const { payload } = params;
    this.log.debug("onBookingCreated", safeStringify(payload));
    if (payload.config.isDryRun) {
      return;
    }
    await this.onBookingCreatedOrRescheduled(payload);
  }

  async onBookingRescheduled(params: OnBookingRescheduledParams) {
    const { payload } = params;
    this.log.debug("onBookingRescheduled", safeStringify(payload));
    if (payload.config.isDryRun) {
      return;
    }
    await this.onBookingCreatedOrRescheduled(payload);
  }

  async onRecurringOccurrenceCreated(params: OnRecurringOccurrenceCreatedParams) {
    const { payload } = params;
    this.log.debug("onRecurringOccurrenceCreated", safeStringify(payload));
    if (payload.config.isDryRun) {
      return;
    }
    try {
      const service = await this.deps.getNotetakerChoiceService?.();
      await service?.onRecurringOccurrenceCreated({ bookingUid: payload.booking.uid });
    } catch (error) {
      this.log.error(
        "Error while applying the notetaker default to a recurring occurrence",
        safeStringify(error)
      );
    }
  }

  private async onBookingCreatedOrRescheduled(payload: BookingCreatedPayload | BookingRescheduledPayload) {
    const results = await Promise.allSettled([
      this.updatePrivateLinkUsage(payload.bookingFormData.hashedLink),
      this.applyNotetakerChoice(payload),
    ]);
    results.forEach((result) => {
      if (result.status === "rejected") {
        this.log.error(
          "Error while executing onBookingCreatedOrRescheduled task",
          safeStringify(result.reason)
        );
      }
    });
  }

  private async updatePrivateLinkUsage(hashedLink: string | null) {
    try {
      if (hashedLink) {
        await this.deps.hashedLinkService.validateAndIncrementUsage(hashedLink);
      }
    } catch (error) {
      this.log.error("Error while updating hashed link", safeStringify(error));
    }
  }

  private async applyNotetakerChoice(payload: BookingCreatedPayload | BookingRescheduledPayload) {
    const getService = this.deps.getNotetakerChoiceService;
    if (!getService) return;
    try {
      const service = await getService();
      if ("oldBooking" in payload) {
        await service.onBookingRescheduled({
          bookingUid: payload.booking.uid,
          oldBookingUid: payload.oldBooking.uid,
        });
      } else {
        await service.onBookingCreated({ bookingUid: payload.booking.uid });
      }
    } catch (error) {
      this.log.error("Error while applying the notetaker choice", safeStringify(error));
    }
  }
}
