/** @vitest-environment node */

import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookingEventHandlerService } from "../lib/onBookingEvents/BookingEventHandlerService";
import type { BookingCreatedPayload } from "../lib/onBookingEvents/types";

function buildPayload(isDryRun: boolean): BookingCreatedPayload {
  return {
    config: { isDryRun },
    bookingFormData: { hashedLink: null },
    booking: {
      uid: "booking-uid-1",
      startTime: new Date("2026-01-10T10:00:00.000Z"),
      endTime: new Date("2026-01-10T10:30:00.000Z"),
      status: "ACCEPTED",
      userId: 7,
    },
  };
}

// The DI tokens are Symbol(...) and the notetaker config is read from the env at resolution time, so
// every import must happen in the same module generation as the stubbed env.
async function load() {
  vi.resetModules();
  vi.stubEnv("NOTETAKER_JOIN_LEAD_SECONDS", "abc");

  const { createContainer } = await import("@calcom/features/di/di");
  const { moduleLoader } = await import("./BookingEventHandlerService.module");
  const { moduleLoader: loggerModuleLoader } = await import(
    "@calcom/features/di/shared/services/logger.service"
  );

  const container = createContainer();
  moduleLoader.loadModule(container);

  const log = container.get<ISimpleLogger>(loggerModuleLoader.token);
  const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);

  return { container, moduleLoader, errorSpy };
}

describe("BookingEventHandlerService DI module with an invalid NOTETAKER_* env var", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves the handler and logs the config error instead of failing the booking", async () => {
    const { container, moduleLoader, errorSpy } = await load();

    expect(() => container.get<BookingEventHandlerService>(moduleLoader.token)).not.toThrow();

    const handler = container.get<BookingEventHandlerService>(moduleLoader.token);
    await expect(handler.onBookingCreated({ payload: buildPayload(false) })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "Error while applying the notetaker choice",
      expect.stringContaining("Invalid notetaker configuration")
    );
  });

  it("resolves the handler and logs nothing for a dry run", async () => {
    const { container, moduleLoader, errorSpy } = await load();

    expect(() => container.get<BookingEventHandlerService>(moduleLoader.token)).not.toThrow();

    const handler = container.get<BookingEventHandlerService>(moduleLoader.token);
    await expect(handler.onBookingCreated({ payload: buildPayload(true) })).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
