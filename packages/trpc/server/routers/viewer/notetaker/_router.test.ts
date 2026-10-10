import prisma, { readonlyPrisma } from "@calcom/prisma";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCContextInner } from "../../../createContext";
import { createCallerFactory } from "../../../trpc";
import { notetakerRouter } from "./_router";

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  eventTypeFindUnique: vi.fn(),
  sentrySetUser: vi.fn(),
  getStateHandler: vi.fn(),
  setEnabledHandler: vi.fn(),
  stopHandler: vi.fn(),
  listPassagesHandler: vi.fn(),
  regenerateSummaryHandler: vi.fn(),
  getEventTypeDefaultHandler: vi.fn(),
  setEventTypeDefaultHandler: vi.fn(),
  getEventTypeSharingHandler: vi.fn(),
  setEventTypeSharingHandler: vi.fn(),
  listEventTypeSharingCandidatesHandler: vi.fn(),
  listSharedWithMeHandler: vi.fn(),
  setSharingHandler: vi.fn(),
  exportHandler: vi.fn(),
  deleteResultsHandler: vi.fn(),
  getActivityHandler: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/userFromSessionUtils", () => ({
  getUserSession: mocks.getUserSession,
}));

vi.mock("@calcom/prisma", () => {
  const fake = { eventType: { findUnique: mocks.eventTypeFindUnique } };
  return { default: fake, prisma: fake, readonlyPrisma: fake, availabilityUserSelect: {}, userSelect: {} };
});

vi.mock("@sentry/nextjs", () => ({ setUser: mocks.sentrySetUser }));

vi.mock("./getState.handler", () => ({ getStateHandler: mocks.getStateHandler }));
vi.mock("./setEnabled.handler", () => ({ setEnabledHandler: mocks.setEnabledHandler }));
vi.mock("./stop.handler", () => ({ stopHandler: mocks.stopHandler }));
vi.mock("./listPassages.handler", () => ({ listPassagesHandler: mocks.listPassagesHandler }));
vi.mock("./regenerateSummary.handler", () => ({
  regenerateSummaryHandler: mocks.regenerateSummaryHandler,
}));
vi.mock("./getEventTypeDefault.handler", () => ({
  getEventTypeDefaultHandler: mocks.getEventTypeDefaultHandler,
}));
vi.mock("./setEventTypeDefault.handler", () => ({
  setEventTypeDefaultHandler: mocks.setEventTypeDefaultHandler,
}));
vi.mock("./getEventTypeSharing.handler", () => ({
  getEventTypeSharingHandler: mocks.getEventTypeSharingHandler,
}));
vi.mock("./setEventTypeSharing.handler", () => ({
  setEventTypeSharingHandler: mocks.setEventTypeSharingHandler,
}));
vi.mock("./listEventTypeSharingCandidates.handler", () => ({
  listEventTypeSharingCandidatesHandler: mocks.listEventTypeSharingCandidatesHandler,
}));
vi.mock("./listSharedWithMe.handler", () => ({
  listSharedWithMeHandler: mocks.listSharedWithMeHandler,
}));
vi.mock("./setSharing.handler", () => ({ setSharingHandler: mocks.setSharingHandler }));
vi.mock("./export.handler", () => ({ exportHandler: mocks.exportHandler }));
vi.mock("./deleteResults.handler", () => ({ deleteResultsHandler: mocks.deleteResultsHandler }));
vi.mock("./getActivity.handler", () => ({ getActivityHandler: mocks.getActivityHandler }));

const ctx: TRPCContextInner = {
  prisma,
  insightsDb: readonlyPrisma,
  locale: "en",
  traceContext: { traceId: "trace_test", spanId: "span_test", operation: "test" },
};

const createCaller = createCallerFactory(notetakerRouter);
type Caller = ReturnType<typeof createCaller>;

const handlerMocks = [
  mocks.getStateHandler,
  mocks.setEnabledHandler,
  mocks.stopHandler,
  mocks.listPassagesHandler,
  mocks.regenerateSummaryHandler,
  mocks.getEventTypeDefaultHandler,
  mocks.setEventTypeDefaultHandler,
  mocks.getEventTypeSharingHandler,
  mocks.setEventTypeSharingHandler,
  mocks.listEventTypeSharingCandidatesHandler,
  mocks.listSharedWithMeHandler,
  mocks.setSharingHandler,
  mocks.exportHandler,
  mocks.deleteResultsHandler,
  mocks.getActivityHandler,
];

const procedures: {
  name: string;
  handler: ReturnType<typeof vi.fn>;
  expectedInput: unknown;
  invoke: (caller: Caller) => Promise<unknown>;
}[] = [
  {
    name: "getState",
    handler: mocks.getStateHandler,
    expectedInput: { bookingUid: "b1" },
    invoke: (caller) => caller.getState({ bookingUid: "b1" }),
  },
  {
    name: "setEnabled",
    handler: mocks.setEnabledHandler,
    expectedInput: { bookingUid: "b1", enabled: true, scope: "THIS_BOOKING" },
    invoke: (caller) => caller.setEnabled({ bookingUid: "b1", enabled: true }),
  },
  {
    name: "stop",
    handler: mocks.stopHandler,
    expectedInput: { bookingUid: "b1" },
    invoke: (caller) => caller.stop({ bookingUid: "b1" }),
  },
  {
    name: "listPassages",
    handler: mocks.listPassagesHandler,
    expectedInput: { bookingUid: "b1", limit: 200 },
    invoke: (caller) => caller.listPassages({ bookingUid: "b1" }),
  },
  {
    name: "regenerateSummary",
    handler: mocks.regenerateSummaryHandler,
    expectedInput: { bookingUid: "b1" },
    invoke: (caller) => caller.regenerateSummary({ bookingUid: "b1" }),
  },
  {
    name: "getEventTypeDefault",
    handler: mocks.getEventTypeDefaultHandler,
    expectedInput: { eventTypeId: 42 },
    invoke: (caller) => caller.getEventTypeDefault({ eventTypeId: 42 }),
  },
  {
    name: "setEventTypeDefault",
    handler: mocks.setEventTypeDefaultHandler,
    expectedInput: { eventTypeId: 42, enabledByDefault: true },
    invoke: (caller) => caller.setEventTypeDefault({ eventTypeId: 42, enabledByDefault: true }),
  },
  {
    name: "getEventTypeSharing",
    handler: mocks.getEventTypeSharingHandler,
    expectedInput: { eventTypeId: 42 },
    invoke: (caller) => caller.getEventTypeSharing({ eventTypeId: 42 }),
  },
  {
    name: "setEventTypeSharing",
    handler: mocks.setEventTypeSharingHandler,
    expectedInput: { eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: [3, 4] },
    invoke: (caller) =>
      caller.setEventTypeSharing({ eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: [3, 4] }),
  },
  {
    name: "listEventTypeSharingCandidates",
    handler: mocks.listEventTypeSharingCandidatesHandler,
    expectedInput: { eventTypeId: 42, search: "sa", cursor: 9, limit: 20 },
    invoke: (caller) => caller.listEventTypeSharingCandidates({ eventTypeId: 42, search: "sa", cursor: 9 }),
  },
  {
    name: "listSharedWithMe",
    handler: mocks.listSharedWithMeHandler,
    expectedInput: { cursor: "c1", limit: 20 },
    invoke: (caller) => caller.listSharedWithMe({ cursor: "c1" }),
  },
  {
    name: "setSharing",
    handler: mocks.setSharingHandler,
    expectedInput: { bookingUid: "b1", shared: true },
    invoke: (caller) => caller.setSharing({ bookingUid: "b1", shared: true }),
  },
  {
    name: "export",
    handler: mocks.exportHandler,
    expectedInput: { bookingUid: "b1", format: "markdown" },
    invoke: (caller) => caller.export({ bookingUid: "b1", format: "markdown" }),
  },
  {
    name: "deleteResults",
    handler: mocks.deleteResultsHandler,
    expectedInput: { bookingUid: "b1" },
    invoke: (caller) => caller.deleteResults({ bookingUid: "b1" }),
  },
  {
    name: "getActivity",
    handler: mocks.getActivityHandler,
    expectedInput: { bookingUid: "b1" },
    invoke: (caller) => caller.getActivity({ bookingUid: "b1" }),
  },
];

describe("notetakerRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserSession.mockResolvedValue({
      user: { id: 7 },
      session: { upId: "usr-7", expires: "2099-01-01T00:00:00.000Z", user: { id: 7 } },
    });
    mocks.eventTypeFindUnique.mockResolvedValue({ userId: 7, users: [], team: null });
    for (const handler of handlerMocks) {
      handler.mockResolvedValue({ sentinel: true });
    }
  });

  it.each(procedures)("$name delegates to its handler with ctx and input", async (procedure) => {
    const result = await procedure.invoke(createCaller(ctx));

    expect(result).toEqual({ sentinel: true });
    expect(procedure.handler).toHaveBeenCalledTimes(1);
    expect(procedure.handler).toHaveBeenCalledWith({
      ctx: expect.objectContaining({ user: expect.objectContaining({ id: 7 }) }),
      input: procedure.expectedInput,
    });
  });

  describe("event type sharing procedures use the eventOwnerProcedure guard", () => {
    const sharingCalls: {
      name: string;
      handler: ReturnType<typeof vi.fn>;
      invoke: (c: Caller) => Promise<unknown>;
    }[] = [
      {
        name: "getEventTypeSharing",
        handler: mocks.getEventTypeSharingHandler,
        invoke: (caller) => caller.getEventTypeSharing({ eventTypeId: 42 }),
      },
      {
        name: "setEventTypeSharing",
        handler: mocks.setEventTypeSharingHandler,
        invoke: (caller) => caller.setEventTypeSharing({ eventTypeId: 42, mode: "TEAM" }),
      },
      {
        name: "listEventTypeSharingCandidates",
        handler: mocks.listEventTypeSharingCandidatesHandler,
        invoke: (caller) => caller.listEventTypeSharingCandidates({ eventTypeId: 42 }),
      },
    ];

    it.each(sharingCalls)("$name rejects a user who does not own the event type", async (call) => {
      mocks.eventTypeFindUnique.mockResolvedValue({ userId: 99, users: [], team: null });

      const error = await call.invoke(createCaller(ctx)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({ code: "FORBIDDEN" });
      expect(call.handler).not.toHaveBeenCalled();
    });

    it.each(sharingCalls)("$name rejects a missing event type", async (call) => {
      mocks.eventTypeFindUnique.mockResolvedValue(null);

      const error = await call.invoke(createCaller(ctx)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TRPCError);
      expect(call.handler).not.toHaveBeenCalled();
    });
  });

  it("rejects an unauthenticated caller", async () => {
    mocks.getUserSession.mockResolvedValue({ user: null, session: null });

    const error = await createCaller(ctx)
      .getState({ bookingUid: "b1" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.getStateHandler).not.toHaveBeenCalled();
  });
});
