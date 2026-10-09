import { MeetLocationType } from "@calcom/app-store/constants";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerConfig } from "@calcom/features/notetaker/lib/config";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "@calcom/features/notetaker/lib/tasker/types";
import { NotetakerAccessService } from "@calcom/features/notetaker/services/NotetakerAccessService";
import { NotetakerChoiceService } from "@calcom/features/notetaker/services/NotetakerChoiceService";
import { createInMemoryNotetakerRepositories } from "@calcom/features/notetaker/tests/InMemoryNotetakerRepositories";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notetakerDisclosureHandler } from "./notetakerDisclosure.handler";
import { ZNotetakerDisclosureInputSchema } from "./notetakerDisclosure.schema";

const holder = vi.hoisted(() => ({ service: null as NotetakerChoiceService | null }));

vi.mock("@calcom/features/notetaker/di/NotetakerChoiceService.container", () => ({
  getNotetakerChoiceService: () => {
    if (!holder.service) throw new Error("holder.service not set");
    return holder.service;
  },
}));

const EVENT_TYPE_ID = 10;

function buildConfig(): NotetakerConfig {
  return {
    limits: {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 900,
      aloneTimeoutSeconds: 120,
      maxDurationSeconds: 14400,
      joinLeadSeconds: 120,
      heartbeatTimeoutSeconds: 180,
      summaryMinWords: 40,
    },
    enabledPlatforms: ["GOOGLE_MEET"],
    // getDisclosure reports enabledByDefault false when the bot provider is unusable
    botProvider: "FAKE",
    botUrl: null,
    botSecret: null,
    summaryModel: "test-model",
    anthropicApiKey: null,
    fakeScenario: "happy",
  };
}

class StubNotetakerTasker implements INotetakerTasker {
  async finalizeSession(_payload: NotetakerFinalizeSessionPayload): Promise<{ runId: string }> {
    return { runId: "run-1" };
  }

  async generateSummary(_payload: NotetakerGenerateSummaryPayload): Promise<{ runId: string }> {
    return { runId: "run-1" };
  }

  async sendNotification(_payload: NotetakerSendNotificationPayload): Promise<{ runId: string }> {
    return { runId: "run-1" };
  }
}

describe("notetakerDisclosureHandler", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;

  const run = (eventTypeId: number = EVENT_TYPE_ID) =>
    notetakerDisclosureHandler({ input: ZNotetakerDisclosureInputSchema.parse({ eventTypeId }) });

  beforeEach(() => {
    repositories = createInMemoryNotetakerRepositories();
    repositories.store.addEventType({
      id: EVENT_TYPE_ID,
      userId: 1,
      teamId: null,
      locations: [{ type: MeetLocationType }],
      ownerName: "Organizer",
    });

    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
    holder.service = new NotetakerChoiceService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      sessionRepository: repositories.sessionRepository,
      transcriptRepository: repositories.transcriptRepository,
      summaryRepository: repositories.summaryRepository,
      activityRepository: repositories.activityRepository,
      accessService: new NotetakerAccessService({
        bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      }),
      featuresRepository: { checkIfUserHasFeature: async () => true },
      userRepository: { findByIds: async () => [] },
      config: buildConfig(),
      notetakerTasker: new StubNotetakerTasker(),
      logger,
    });
  });

  it("returns only the disclosure fields so no booking, attendee or transcript data leaks", async () => {
    await repositories.eventTypeNotetakerSettingsRepository.upsert({
      eventTypeId: EVENT_TYPE_ID,
      enabledByDefault: true,
    });

    const result = await run();

    expect(Object.keys(result).sort()).toEqual(["enabledByDefault", "onBehalfOf", "supportedLocationTypes"]);
  });

  it("reports the seeded default, the owner name and the supported location types", async () => {
    await repositories.eventTypeNotetakerSettingsRepository.upsert({
      eventTypeId: EVENT_TYPE_ID,
      enabledByDefault: true,
    });

    expect(await run()).toEqual({
      enabledByDefault: true,
      onBehalfOf: "Organizer",
      supportedLocationTypes: [MeetLocationType],
    });
  });

  it("reports enabledByDefault false when the event type has no settings row", async () => {
    expect(await run()).toEqual({
      enabledByDefault: false,
      onBehalfOf: "Organizer",
      supportedLocationTypes: [MeetLocationType],
    });
  });

  it("rejects with a not-found ErrorWithCode for an unknown event type", async () => {
    const error = await run(999).then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ErrorWithCode);
    expect(error).toMatchObject({ code: ErrorCode.NotFound, message: "EVENT_TYPE_NOT_FOUND" });
  });
});

describe("ZNotetakerDisclosureInputSchema", () => {
  it.each([[{}], [{ eventTypeId: 1.5 }], [{ eventTypeId: "10" }]])("rejects %j", (input) => {
    expect(ZNotetakerDisclosureInputSchema.safeParse(input).success).toBe(false);
  });

  it("accepts an integer event type id", () => {
    expect(ZNotetakerDisclosureInputSchema.parse({ eventTypeId: 10 })).toEqual({ eventTypeId: 10 });
  });
});
