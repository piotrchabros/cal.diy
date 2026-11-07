import prisma, { readonlyPrisma } from "@calcom/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCContextInner } from "../../../createContext";
import { createCallerFactory } from "../../../trpc";
import { webhookRouter } from "./_router";

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  webhookFindUnique: vi.fn(),
  eventTypeFindUnique: vi.fn(),
  getAdminOrOwnerMembership: vi.fn(),
  findByWebhookId: vi.fn(),
  listWebhooks: vi.fn(),
  editHandler: vi.fn(),
  deleteHandler: vi.fn(),
  testTriggerHandler: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/userFromSessionUtils", () => ({
  getUserSession: mocks.getUserSession,
}));

vi.mock("@calcom/prisma", () => {
  const fake = {
    webhook: { findUnique: mocks.webhookFindUnique },
    eventType: { findUnique: mocks.eventTypeFindUnique },
  };
  return { default: fake, prisma: fake, readonlyPrisma: fake, availabilityUserSelect: {}, userSelect: {} };
});

vi.mock("@sentry/nextjs", () => ({ setUser: vi.fn() }));

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: { getAdminOrOwnerMembership: mocks.getAdminOrOwnerMembership },
}));

vi.mock("@calcom/features/di/webhooks/containers/webhook", () => ({
  getWebhookFeature: () => ({
    repository: { findByWebhookId: mocks.findByWebhookId, listWebhooks: mocks.listWebhooks },
  }),
}));

vi.mock("./edit.handler", () => ({ editHandler: mocks.editHandler }));
vi.mock("./delete.handler", () => ({ deleteHandler: mocks.deleteHandler }));
vi.mock("./testTrigger.handler", () => ({ testTriggerHandler: mocks.testTriggerHandler }));

const ctx: TRPCContextInner = {
  prisma,
  insightsDb: readonlyPrisma,
  locale: "en",
  traceContext: { traceId: "trace_test", spanId: "span_test", operation: "test" },
};

const createCaller = createCallerFactory(webhookRouter);

const teamOwnedWebhook = { id: "wh-team", userId: null, teamId: 3, eventTypeId: null };
const fullTeamOwnedWebhook = { ...teamOwnedWebhook, secret: "s3cret", includeMemberMeetings: true };

describe("webhook router access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserSession.mockResolvedValue({
      user: { id: 7 },
      session: { upId: "usr-7", expires: "2099-01-01T00:00:00.000Z", user: { id: 7 } },
    });
    mocks.findByWebhookId.mockResolvedValue(fullTeamOwnedWebhook);
    mocks.editHandler.mockResolvedValue({ ok: true });
    mocks.deleteHandler.mockResolvedValue({ id: "wh-team" });
    mocks.testTriggerHandler.mockResolvedValue({ ok: true });
    mocks.listWebhooks.mockResolvedValue([]);
  });

  describe("team-owned webhook (userId null)", () => {
    beforeEach(() => {
      mocks.webhookFindUnique.mockResolvedValue(teamOwnedWebhook);
    });

    it.each([
      ["a non-member", null],
      ["a plain member", null],
    ])("forbids %s from reading it and does not return the secret", async (_label, membership) => {
      mocks.getAdminOrOwnerMembership.mockResolvedValue(membership);

      const result = await createCaller(ctx)
        .get({ id: "wh-team" })
        .catch((e: unknown) => e);

      expect(result).toMatchObject({ code: "FORBIDDEN" });
      expect(JSON.stringify(result)).not.toContain("s3cret");
      expect(mocks.getAdminOrOwnerMembership).toHaveBeenCalledWith(7, 3);
      expect(mocks.findByWebhookId).not.toHaveBeenCalled();
    });

    it("forbids a non-admin from editing, deleting or test-triggering it", async () => {
      mocks.getAdminOrOwnerMembership.mockResolvedValue(null);
      const caller = createCaller(ctx);

      await expect(caller.edit({ id: "wh-team", payloadTemplate: null })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(caller.delete({ id: "wh-team" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller.testTrigger({ webhookId: "wh-team", url: "https://crm.example.com/hook", type: "PING" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.editHandler).not.toHaveBeenCalled();
      expect(mocks.deleteHandler).not.toHaveBeenCalled();
      expect(mocks.testTriggerHandler).not.toHaveBeenCalled();
    });

    it("lets a team admin get, edit and delete it", async () => {
      mocks.getAdminOrOwnerMembership.mockResolvedValue({ id: 1 });
      const caller = createCaller(ctx);

      await expect(caller.get({ id: "wh-team" })).resolves.toMatchObject({ secret: "s3cret" });
      await expect(caller.edit({ id: "wh-team", payloadTemplate: null })).resolves.toEqual({ ok: true });
      await expect(caller.delete({ id: "wh-team" })).resolves.toEqual({ id: "wh-team" });
    });
  });

  describe("user-owned webhook", () => {
    it("lets the owner read it without a team membership check", async () => {
      mocks.webhookFindUnique.mockResolvedValue({ id: "wh-own", userId: 7, teamId: 3, eventTypeId: null });
      mocks.findByWebhookId.mockResolvedValue({ id: "wh-own", userId: 7, secret: "mine" });

      await expect(createCaller(ctx).get({ id: "wh-own" })).resolves.toMatchObject({ secret: "mine" });
      expect(mocks.getAdminOrOwnerMembership).not.toHaveBeenCalled();
    });

    it("forbids another user regardless of team role", async () => {
      mocks.webhookFindUnique.mockResolvedValue({ id: "wh-other", userId: 99, teamId: 3, eventTypeId: null });
      mocks.getAdminOrOwnerMembership.mockResolvedValue({ id: 1 });

      await expect(createCaller(ctx).get({ id: "wh-other" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.findByWebhookId).not.toHaveBeenCalled();
    });

    it("keeps allowing ownerless non-team webhooks through the middleware", async () => {
      mocks.webhookFindUnique.mockResolvedValue({
        id: "wh-plat",
        userId: null,
        teamId: null,
        eventTypeId: null,
      });
      mocks.findByWebhookId.mockResolvedValue({ id: "wh-plat" });

      await expect(createCaller(ctx).get({ id: "wh-plat" })).resolves.toEqual({ id: "wh-plat" });
      expect(mocks.getAdminOrOwnerMembership).not.toHaveBeenCalled();
    });
  });

  describe("event-type webhooks", () => {
    const eventTypeWebhook = { id: "wh-et", userId: null, teamId: null, eventTypeId: 11 };

    describe("by webhook id", () => {
      beforeEach(() => {
        mocks.webhookFindUnique.mockResolvedValue(eventTypeWebhook);
        mocks.findByWebhookId.mockResolvedValue({ ...eventTypeWebhook, secret: "et-secret" });
      });

      it("lets the event type owner get it without a membership lookup", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue({ userId: 7, teamId: null });

        await expect(createCaller(ctx).get({ id: "wh-et" })).resolves.toMatchObject({ secret: "et-secret" });
        expect(mocks.getAdminOrOwnerMembership).not.toHaveBeenCalled();
      });

      it("lets a team admin get, edit and delete a team event type's webhook", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue({ userId: null, teamId: 3 });
        mocks.getAdminOrOwnerMembership.mockResolvedValue({ id: 1 });
        mocks.deleteHandler.mockResolvedValue({ id: "wh-et" });
        const caller = createCaller(ctx);

        await expect(caller.get({ id: "wh-et" })).resolves.toMatchObject({ secret: "et-secret" });
        await expect(caller.edit({ id: "wh-et", payloadTemplate: null })).resolves.toEqual({ ok: true });
        await expect(caller.delete({ id: "wh-et" })).resolves.toEqual({ id: "wh-et" });
        expect(mocks.getAdminOrOwnerMembership).toHaveBeenCalledWith(7, 3);
      });

      it("forbids a plain team member from getting, editing or deleting it", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue({ userId: null, teamId: 3 });
        mocks.getAdminOrOwnerMembership.mockResolvedValue(null);
        const caller = createCaller(ctx);

        await expect(caller.get({ id: "wh-et" })).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(caller.edit({ id: "wh-et", payloadTemplate: null })).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        await expect(caller.delete({ id: "wh-et" })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(mocks.findByWebhookId).not.toHaveBeenCalled();
        expect(mocks.editHandler).not.toHaveBeenCalled();
        expect(mocks.deleteHandler).not.toHaveBeenCalled();
      });

      it("forbids access to another user's personal event type webhook", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue({ userId: 99, teamId: null });

        await expect(createCaller(ctx).get({ id: "wh-et" })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(mocks.findByWebhookId).not.toHaveBeenCalled();
      });

      it("returns NOT_FOUND when the event type is missing", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue(null);

        await expect(createCaller(ctx).get({ id: "wh-et" })).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(mocks.findByWebhookId).not.toHaveBeenCalled();
      });
    });

    describe("by event type id only", () => {
      it("lets the event type owner list its webhooks without a membership lookup", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue({ userId: 7, teamId: null });

        await expect(createCaller(ctx).list({ eventTypeId: 11 })).resolves.toEqual([]);
        expect(mocks.listWebhooks).toHaveBeenCalledWith(expect.objectContaining({ eventTypeId: 11 }));
        expect(mocks.getAdminOrOwnerMembership).not.toHaveBeenCalled();
      });

      it("lets a team admin list a team event type's webhooks", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue({ userId: null, teamId: 3 });
        mocks.getAdminOrOwnerMembership.mockResolvedValue({ id: 1 });

        await expect(createCaller(ctx).list({ eventTypeId: 11 })).resolves.toEqual([]);
        expect(mocks.listWebhooks).toHaveBeenCalledWith(expect.objectContaining({ eventTypeId: 11 }));
      });

      it("forbids a plain team member from listing them", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue({ userId: null, teamId: 3 });
        mocks.getAdminOrOwnerMembership.mockResolvedValue(null);

        await expect(createCaller(ctx).list({ eventTypeId: 11 })).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        expect(mocks.listWebhooks).not.toHaveBeenCalled();
      });

      it("forbids listing another user's personal event type webhooks", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue({ userId: 99, teamId: null });

        await expect(createCaller(ctx).list({ eventTypeId: 11 })).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        expect(mocks.listWebhooks).not.toHaveBeenCalled();
      });

      it("returns NOT_FOUND when the event type is missing", async () => {
        mocks.eventTypeFindUnique.mockResolvedValue(null);

        await expect(createCaller(ctx).list({ eventTypeId: 11 })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        expect(mocks.listWebhooks).not.toHaveBeenCalled();
      });
    });
  });
});
