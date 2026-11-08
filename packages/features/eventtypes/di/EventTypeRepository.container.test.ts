import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { describe, expect, it } from "vitest";
import { getEventTypeRepository } from "./EventTypeRepository.container";

describe("getEventTypeRepository", () => {
  it("returns an EventTypeRepository instance", () => {
    expect(getEventTypeRepository()).toBeInstanceOf(EventTypeRepository);
  });

  it("returns the same instance on repeated calls", () => {
    expect(getEventTypeRepository()).toBe(getEventTypeRepository());
  });
});
