import { prisma } from "@calcom/prisma";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { INotetakerBotGateway, NotetakerBotGatewayBinding } from "../bot/INotetakerBotGateway";
import { createNotetakerBotGatewayError } from "../bot/INotetakerBotGateway";
import { getNotetakerConfig } from "../lib/config";
import type { INotetakerTasker } from "../lib/tasker/types";
import { PrismaBookingNotetakerRepository } from "../repositories/PrismaBookingNotetakerRepository";
import { PrismaEventTypeNotetakerSettingsRepository } from "../repositories/PrismaEventTypeNotetakerSettingsRepository";
import { PrismaNotetakerActivityRepository } from "../repositories/PrismaNotetakerActivityRepository";
import { PrismaNotetakerSessionRepository } from "../repositories/PrismaNotetakerSessionRepository";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import { NotetakerAccessService } from "./NotetakerAccessService";
import { NotetakerDispatchService } from "./NotetakerDispatchService";

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(
    async (locale: string) => (key: string, vars?: Record<string, string>) =>
      `${locale}:${key}:${JSON.stringify(vars ?? {})}`
  ),
}));

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const bookingNotetakerRepository = new PrismaBookingNotetakerRepository(prisma);
const sessionRepository = new PrismaNotetakerSessionRepository(prisma);
const activityRepository = new PrismaNotetakerActivityRepository(prisma);
const eventTypeNotetakerSettingsRepository = new PrismaEventTypeNotetakerSettingsRepository(prisma);

let userId: number | undefined;
let bookingId: number | undefined;
let bookingUid: string | undefined;
let bookingCounter = 0;

function requireIds() {
  if (bookingId === undefined || bookingUid === undefined) {
    throw new Error("Test setup did not complete: booking id or uid is missing");
  }
  return { bookingId, bookingUid };
}

function createCountingGateway(mode: "ok" | "transient"): {
  gateway: INotetakerBotGateway;
  calls: () => number;
} {
  let joinCalls = 0;
  const gateway: INotetakerBotGateway = {
    requestJoin: async (input) => {
      joinCalls += 1;
      if (mode === "transient") throw createNotetakerBotGatewayError("TRANSIENT", "bot unreachable");
      return { externalRef: `it-ref-${input.sessionId}` };
    },
    requestStop: async () => {},
    getState: async () => null,
  };
  return { gateway, calls: () => joinCalls };
}

// Only NODE_ENV=production changes the parsed defaults, so "test" keeps the stock config while ignoring NOTETAKER_* in the developer's environment.
const defaultsOnlyEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };

// A real tasker would send email from the developer's machine on every successful dispatch.
const stubTasker: INotetakerTasker = {
  finalizeSession: async () => ({ runId: "stub" }),
  generateSummary: async () => ({ runId: "stub" }),
  sendNotification: async () => ({ runId: "stub" }),
};

function buildService(gateway: INotetakerBotGateway): NotetakerDispatchService {
  const binding: NotetakerBotGatewayBinding = { gateway, provider: "FAKE" };
  return new NotetakerDispatchService({
    bookingNotetakerRepository,
    sessionRepository,
    activityRepository,
    botGatewayResolver: { resolve: () => binding },
    config: getNotetakerConfig(defaultsOnlyEnv),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    accessService: new NotetakerAccessService({
      bookingNotetakerRepository,
      sessionRepository,
      eventTypeNotetakerSettingsRepository,
      membershipLookup: new InMemoryNotetakerMembershipLookup(),
    }),
    userRepository: { findByIds: async () => [] },
    notetakerTasker: stubTasker,
    calendarInviteService: { ensureBotInvited: async () => "NOT_CONFIGURED" },
  });
}

function findSessions(id: number) {
  return prisma.notetakerSession.findMany({
    where: { bookingId: id },
    select: { id: true, status: true, externalRef: true },
  });
}

function findChoice(id: number) {
  return prisma.bookingNotetaker.findUnique({
    where: { bookingId: id },
    select: { enabled: true, pendingDispatch: true },
  });
}

// The sweep (`dispatchDue`) is never called here: against a developer database it would dispatch
// every armed booking, not only this test's. `dispatchForBooking` takes the same compare-and-swap path.
describe("NotetakerDispatchService (integration)", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `notetaker-dispatch-it-${runId}@example.com`,
        username: `notetaker-dispatch-it-${runId}`,
      },
      select: { id: true },
    });
    userId = user.id;
  });

  beforeEach(async () => {
    if (userId === undefined) throw new Error("Test user was not created");
    bookingCounter += 1;
    const booking = await prisma.booking.create({
      data: {
        uid: `notetaker-dispatch-it-${runId}-${bookingCounter}`,
        title: "Notetaker dispatch integration test",
        startTime: new Date(Date.now() + 60_000),
        endTime: new Date(Date.now() + 31 * 60_000),
        userId,
        status: "ACCEPTED",
        location: "https://meet.google.com/abc-defg-hij",
      },
      select: { id: true, uid: true },
    });
    bookingId = booking.id;
    bookingUid = booking.uid;

    await prisma.bookingNotetaker.create({
      data: { bookingId: booking.id, enabled: true, pendingDispatch: true, source: "HOST" },
      select: { bookingId: true },
    });
  });

  afterEach(async () => {
    // Prisma treats `where: { id: undefined }` as no filter, so every delete needs an explicit guard
    // to avoid wiping a real database when setup failed before the id was assigned.
    if (bookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: bookingId } });
    }
    bookingId = undefined;
    bookingUid = undefined;
  });

  afterAll(async () => {
    if (userId !== undefined) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    userId = undefined;
  });

  it("two concurrent dispatches create one session and call the gateway once", async () => {
    const ids = requireIds();
    const { gateway, calls } = createCountingGateway("ok");
    const service = buildService(gateway);

    await Promise.all([
      service.dispatchForBooking({ bookingUid: ids.bookingUid }),
      service.dispatchForBooking({ bookingUid: ids.bookingUid }),
    ]);

    const sessions = await findSessions(ids.bookingId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("SCHEDULED");
    expect(sessions[0].externalRef).toBe(`it-ref-${sessions[0].id}`);
    expect(calls()).toBe(1);
    expect(await findChoice(ids.bookingId)).toEqual({ enabled: true, pendingDispatch: false });
  });

  it("three concurrent dispatches, standing in for an immediate dispatch racing the sweep, create one session", async () => {
    const ids = requireIds();
    const { gateway, calls } = createCountingGateway("ok");
    const service = buildService(gateway);

    await Promise.all([
      service.dispatchForBooking({ bookingUid: ids.bookingUid }),
      service.dispatchForBooking({ bookingUid: ids.bookingUid }),
      service.dispatchForBooking({ bookingUid: ids.bookingUid }),
    ]);

    const sessions = await findSessions(ids.bookingId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("SCHEDULED");
    expect(sessions[0].externalRef).toBe(`it-ref-${sessions[0].id}`);
    expect(calls()).toBe(1);
    expect(await findChoice(ids.bookingId)).toEqual({ enabled: true, pendingDispatch: false });
  });

  // A single call on purpose: after the re-arm a late concurrent caller could legitimately win the
  // swap and call the gateway again, which would make the call count flaky.
  it("a transient gateway failure removes the session and arms the choice again", async () => {
    const ids = requireIds();
    const { gateway, calls } = createCountingGateway("transient");
    const service = buildService(gateway);

    await service.dispatchForBooking({ bookingUid: ids.bookingUid });

    expect(await findSessions(ids.bookingId)).toHaveLength(0);
    expect(await findChoice(ids.bookingId)).toEqual({ enabled: true, pendingDispatch: true });
    expect(calls()).toBe(1);
  });
});
