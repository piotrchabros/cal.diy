import process from "node:process";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { ENABLE_ASYNC_TASKER } from "@calcom/lib/constants";
import { prisma } from "@calcom/prisma";
import { expect } from "vitest";
import { z } from "zod";
import { FakeBotGateway } from "../bot/FakeBotGateway";
import type { INotetakerBotGateway, NotetakerBotGatewayBinding } from "../bot/INotetakerBotGateway";
import { getNotetakerSessionEventService } from "../di/NotetakerSessionEventService.container";
import { getNotetakerTasker } from "../di/tasker/NotetakerTasker.container";
import type { NotetakerFakeScenario } from "../lib/config";
import { getNotetakerConfig } from "../lib/config";
import { PrismaBookingNotetakerRepository } from "../repositories/PrismaBookingNotetakerRepository";
import { PrismaEventTypeNotetakerSettingsRepository } from "../repositories/PrismaEventTypeNotetakerSettingsRepository";
import { PrismaNotetakerActivityRepository } from "../repositories/PrismaNotetakerActivityRepository";
import { PrismaNotetakerSessionRepository } from "../repositories/PrismaNotetakerSessionRepository";
import { NotetakerAccessService } from "../services/NotetakerAccessService";
import { NotetakerDispatchService } from "../services/NotetakerDispatchService";
import { InMemoryNotetakerMembershipLookup } from "./InMemoryNotetakerMembershipLookup";

const DEFAULT_STARTS_IN_MS = 60_000;
const DEFAULT_DURATION_MS = 30 * 60_000;

const eventTypeLocationsSchema = z.array(
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
);

const silentLogger: ISimpleLogger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

function buildAccessService(
  bookingNotetakerRepository: PrismaBookingNotetakerRepository,
  sessionRepository: PrismaNotetakerSessionRepository
): NotetakerAccessService {
  return new NotetakerAccessService({
    bookingNotetakerRepository,
    sessionRepository,
    eventTypeNotetakerSettingsRepository: new PrismaEventTypeNotetakerSettingsRepository(prisma),
    // No shared viewer takes part in the quickstart flows, so nobody is a member.
    membershipLookup: new InMemoryNotetakerMembershipLookup(),
  });
}

function assertQuickstartEnvironment(): void {
  // The default DATABASE_URL of this checkout is a live site's database and the harness writes rows.
  // The message never carries DATABASE_URL, which holds credentials.
  if (!isQuickstartIsolatedDatabase()) {
    throw new Error(`The notetaker quickstart harness ${QUICKSTART_SKIP_MESSAGE}`);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("The notetaker quickstart harness must not run with NODE_ENV=production");
  }
  // With the async tasker on, finalize, summary and notifications would go to Trigger.dev instead
  // of running inline, and no test could await them.
  if (ENABLE_ASYNC_TASKER) {
    throw new Error(
      "The notetaker quickstart harness needs ENABLE_ASYNC_TASKER=false before any import: set the quickstart env block in vi.hoisted"
    );
  }
  // The DI containers read the environment once; a real provider or an Anthropic key here would
  // mean network calls from a test run.
  const envConfig = getNotetakerConfig();
  if (envConfig.botProvider !== "FAKE") {
    throw new Error("The notetaker quickstart harness needs NOTETAKER_BOT_PROVIDER=fake");
  }
  if (envConfig.anthropicApiKey !== null) {
    throw new Error("The notetaker quickstart harness needs an empty ANTHROPIC_API_KEY");
  }
}

export const QUICKSTART_MEET_LINK = "https://meet.google.com/abc-defg-hij";
export const QUICKSTART_BOT_SECRET = "quickstart-it-secret";

export const QUICKSTART_ISOLATED_DATABASE = "localhost:5547/calendso_it";
export const QUICKSTART_SKIP_MESSAGE = `needs NOTETAKER_IT_ISOLATED_DB=1 and a DATABASE_URL on ${QUICKSTART_ISOLATED_DATABASE}; load .ai/tmp/notetaker/it.env first`;

export type QuickstartUser = { id: number; email: string; name: string };
export type QuickstartBooking = { id: number; uid: string };

export interface QuickstartHarness {
  readonly runId: string;
  createUser(opts: { label: string; notetakerFlag: boolean }): Promise<QuickstartUser>;
  createEventType(opts: { ownerId: number; label: string; locations: unknown[] }): Promise<{ id: number }>;
  createBooking(opts: {
    hostId: number;
    label: string;
    location?: string | null;
    startsInMs?: number;
    durationMs?: number;
    attendees?: { email: string; name: string }[];
    eventTypeId?: number;
    status?: "ACCEPTED" | "PENDING" | "CANCELLED";
    fromReschedule?: string;
  }): Promise<QuickstartBooking>;
  createDispatch(gateway: INotetakerBotGateway): NotetakerDispatchService;
  createFakeBot(scenario: NotetakerFakeScenario): {
    gateway: FakeBotGateway;
    dispatch: NotetakerDispatchService;
  };
  settle(gateway: FakeBotGateway): Promise<void>;
  cleanup(): Promise<void>;
}

export function isQuickstartIsolatedDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NOTETAKER_IT_ISOLATED_DB === "1" && (env.DATABASE_URL ?? "").includes(QUICKSTART_ISOLATED_DATABASE)
  );
}

// Test files inline these assignments in vi.hoisted instead of calling this: hoisted code runs
// before any import, and importing this module first would load packages/lib/constants.ts, which
// reads ENABLE_ASYNC_TASKER once.
export function applyQuickstartEnv(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The notetaker quickstart walk-through must not run with NODE_ENV=production");
  }
  process.env.ENABLE_ASYNC_TASKER = "false";
  process.env.NOTETAKER_BOT_PROVIDER = "fake";
  process.env.NOTETAKER_BOT_SECRET = QUICKSTART_BOT_SECRET;
  process.env.ANTHROPIC_API_KEY = "";
  delete process.env.NOTETAKER_FAKE_SCENARIO;
  delete process.env.NOTETAKER_SUMMARY_MIN_WORDS;
  delete process.env.NOTETAKER_JOIN_LEAD_SECONDS;
  delete process.env.NOTETAKER_ENABLED_PLATFORMS;
}

export async function createQuickstartHarness(label: string): Promise<QuickstartHarness> {
  assertQuickstartEnvironment();

  const runId = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userIds: number[] = [];
  const eventTypeIds: number[] = [];
  const bookingIds: number[] = [];
  let sequence = 0;

  const bookingNotetakerRepository = new PrismaBookingNotetakerRepository(prisma);
  const sessionRepository = new PrismaNotetakerSessionRepository(prisma);
  const activityRepository = new PrismaNotetakerActivityRepository(prisma);
  const accessService = buildAccessService(bookingNotetakerRepository, sessionRepository);
  const userRepository = new UserRepository(prisma);
  // Stock limits whatever NOTETAKER_* the developer's environment holds. apps/web augments
  // ProcessEnv with required keys, so a bare literal is rejected there: start from the real
  // environment (never production, checked above) and drop the overrides.
  const testEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(testEnv)) {
    if (key.startsWith("NOTETAKER_")) delete testEnv[key];
  }
  const config = getNotetakerConfig(testEnv);

  function createDispatch(gateway: INotetakerBotGateway): NotetakerDispatchService {
    const binding: NotetakerBotGatewayBinding = { gateway, provider: "FAKE" };
    return new NotetakerDispatchService({
      bookingNotetakerRepository,
      sessionRepository,
      activityRepository,
      botGatewayResolver: { resolve: () => binding },
      config,
      logger: silentLogger,
      accessService,
      userRepository,
      notetakerTasker: getNotetakerTasker(),
      calendarInviteService: { ensureBotInvited: async () => "NOT_CONFIGURED" },
    });
  }

  return {
    runId,

    async createUser(opts) {
      const name = `Quickstart ${opts.label}`;
      const user = await prisma.user.create({
        data: {
          email: `notetaker-qs-${opts.label}-${runId}@example.com`,
          username: `notetaker-qs-${opts.label}-${runId}`,
          name,
          emailVerified: new Date(),
          locale: "en",
        },
        select: { id: true, email: true },
      });
      userIds.push(user.id);

      if (opts.notetakerFlag) {
        await prisma.userFeatures.create({
          data: { userId: user.id, featureId: "notetaker", enabled: true, assignedBy: "quickstart-it" },
          select: { userId: true },
        });
      }
      return { id: user.id, email: user.email, name };
    },

    async createEventType(opts) {
      const eventType = await prisma.eventType.create({
        data: {
          title: `Notetaker quickstart ${opts.label}`,
          slug: `notetaker-qs-${opts.label}-${runId}`,
          length: 30,
          userId: opts.ownerId,
          locations: eventTypeLocationsSchema.parse(opts.locations),
        },
        select: { id: true },
      });
      eventTypeIds.push(eventType.id);
      return { id: eventType.id };
    },

    async createBooking(opts) {
      // The booking idempotency-key extension derives a unique key for every ACCEPTED create from
      // startTime, endTime and `user.connect.id`. Hence the relation form of the host, and one
      // extra millisecond per booking so two bookings of one host never share a start time.
      sequence += 1;
      const start = Date.now() + (opts.startsInMs ?? DEFAULT_STARTS_IN_MS) + sequence;
      const end = start + (opts.durationMs ?? DEFAULT_DURATION_MS);

      const booking = await prisma.booking.create({
        data: {
          uid: `notetaker-qs-${opts.label}-${runId}-${sequence}`,
          title: `Notetaker quickstart ${opts.label}`,
          startTime: new Date(start),
          endTime: new Date(end),
          status: opts.status ?? "ACCEPTED",
          location: opts.location === undefined ? QUICKSTART_MEET_LINK : opts.location,
          fromReschedule: opts.fromReschedule,
          user: { connect: { id: opts.hostId } },
          eventType: opts.eventTypeId === undefined ? undefined : { connect: { id: opts.eventTypeId } },
          attendees: {
            create: (opts.attendees ?? []).map((attendee) => ({
              email: attendee.email,
              name: attendee.name,
              timeZone: "UTC",
              locale: "en",
            })),
          },
        },
        select: { id: true, uid: true },
      });
      bookingIds.push(booking.id);
      return { id: booking.id, uid: booking.uid };
    },

    createDispatch,

    createFakeBot(scenario) {
      const gateway = new FakeBotGateway({
        scenario,
        eventSink: async (event) => {
          await getNotetakerSessionEventService().handleEvent(event);
        },
      });
      return { gateway, dispatch: createDispatch(gateway) };
    },

    async settle(gateway) {
      await gateway.whenIdle();
      // The fake bot swallows sink failures into scriptErrors; without this a broken pipeline
      // would only show up as a missing row.
      expect(gateway.scriptErrors).toEqual([]);
    },

    // Prisma treats an absent filter as "all rows", so each delete is limited to the ids this
    // harness created and skipped when there are none.
    async cleanup() {
      if (bookingIds.length > 0) {
        await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
        bookingIds.length = 0;
      }
      if (eventTypeIds.length > 0) {
        await prisma.eventType.deleteMany({ where: { id: { in: eventTypeIds } } });
        eventTypeIds.length = 0;
      }
      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        userIds.length = 0;
      }
    },
  };
}
