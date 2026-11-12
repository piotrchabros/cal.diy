import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_SENDER_ERRORS } from "../lib/emailSenderPolicy";
import { ORGANIZATION_ERRORS } from "../lib/organizationErrors";
import type {
  IOrganizationEmailSenderRepository,
  OrganizationEmailSenderRecord,
} from "../repositories/interfaces/IOrganizationEmailSenderRepository";
import { OrganizationEmailSenderService } from "./OrganizationEmailSenderService";

const ORG_ID = 7;

const makeRecord = (
  overrides: Partial<OrganizationEmailSenderRecord> = {}
): OrganizationEmailSenderRecord => ({
  organizationId: ORG_ID,
  emailFromName: "Jelly",
  emailFromAddress: "hello@jellymatch.tech",
  customDomain: "cal.jellymatch.tech",
  ...overrides,
});

function setup(
  options: { role?: OrganizationRoleDto | null; record?: OrganizationEmailSenderRecord | null } = {}
) {
  const record = options.record === undefined ? makeRecord() : options.record;
  const repository = {
    findByOrganizationId: vi.fn().mockResolvedValue(record),
    update: vi.fn().mockResolvedValue(record),
    findOrganizationIdByUserId: vi.fn().mockResolvedValue(ORG_ID),
    findOrganizationIdByUserEmail: vi.fn().mockResolvedValue(ORG_ID),
    findOrganizationIdByTeamId: vi.fn().mockResolvedValue(ORG_ID),
  } satisfies IOrganizationEmailSenderRepository;
  const getRole = vi.fn().mockResolvedValue(options.role === undefined ? "ADMIN" : options.role);
  const service = new OrganizationEmailSenderService({
    emailSenderRepository: repository,
    organizationMembershipService: { getRole },
    emailSenderConfig: { defaultName: "Cal", defaultAddress: "no-reply@cal.test" },
  });
  return { service, repository, getRole };
}

describe("OrganizationEmailSenderService", () => {
  describe("get", () => {
    it("throws NotFound for non-members", async () => {
      const { service } = setup({ role: null });
      await expect(service.get({ organizationId: ORG_ID, viewerUserId: 1 })).rejects.toThrow(
        ORGANIZATION_ERRORS.notFound
      );
    });

    it("returns settings with fallbacks, parent allowed domain and active address", async () => {
      const { service } = setup();
      await expect(service.get({ organizationId: ORG_ID, viewerUserId: 1 })).resolves.toEqual({
        senderName: "Jelly",
        senderAddress: "hello@jellymatch.tech",
        senderAddressActive: true,
        allowedDomain: "jellymatch.tech",
        fallbackSenderName: "Cal",
        fallbackSenderAddress: "no-reply@cal.test",
        canEdit: true,
      });
    });

    it("marks members as read-only", async () => {
      const { service } = setup({ role: "MEMBER" });
      expect((await service.get({ organizationId: ORG_ID, viewerUserId: 1 })).canEdit).toBe(false);
    });

    it("flags the address inactive when the domain no longer matches and keeps short domains whole", async () => {
      const { service } = setup({ record: makeRecord({ customDomain: "other.io" }) });
      const result = await service.get({ organizationId: ORG_ID, viewerUserId: 1 });
      expect(result.senderAddressActive).toBe(false);
      expect(result.allowedDomain).toBe("other.io");
    });

    it("handles an organization without a record or domain", async () => {
      const { service } = setup({ record: null });
      const result = await service.get({ organizationId: ORG_ID, viewerUserId: 1 });
      expect(result).toMatchObject({
        senderName: null,
        senderAddress: null,
        senderAddressActive: false,
        allowedDomain: null,
      });
    });
  });

  describe("update", () => {
    it("rejects non-members and members", async () => {
      const outsider = setup({ role: null });
      await expect(outsider.service.update({ organizationId: ORG_ID, actorUserId: 1 })).rejects.toThrow(
        ORGANIZATION_ERRORS.notFound
      );
      const member = setup({ role: "MEMBER" });
      await expect(member.service.update({ organizationId: ORG_ID, actorUserId: 1 })).rejects.toThrow(
        ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization
      );
      expect(member.repository.update).not.toHaveBeenCalled();
    });

    it("keeps undefined fields and writes normalised ones", async () => {
      const { service, repository } = setup();
      await service.update({ organizationId: ORG_ID, actorUserId: 1, senderName: "  New   Name " });
      expect(repository.update).toHaveBeenCalledWith(ORG_ID, {
        emailFromName: "New Name",
        emailFromAddress: "hello@jellymatch.tech",
      });
    });

    it("clears fields with null or blank", async () => {
      const { service, repository } = setup();
      await service.update({ organizationId: ORG_ID, actorUserId: 1, senderName: null, senderAddress: " " });
      expect(repository.update).toHaveBeenCalledWith(ORG_ID, { emailFromName: null, emailFromAddress: null });
    });

    it("validates both fields before writing", async () => {
      const { service, repository } = setup();
      await expect(
        service.update({
          organizationId: ORG_ID,
          actorUserId: 1,
          senderName: "Fine",
          senderAddress: "not-an-address",
        })
      ).rejects.toThrow(EMAIL_SENDER_ERRORS.addressInvalid);
      await expect(
        service.update({ organizationId: ORG_ID, actorUserId: 1, senderName: "Bad\r\nName" })
      ).rejects.toThrow(EMAIL_SENDER_ERRORS.nameInvalid);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it("requires a custom domain for an address", async () => {
      const { service, repository } = setup({ record: makeRecord({ customDomain: null }) });
      await expect(
        service.update({ organizationId: ORG_ID, actorUserId: 1, senderAddress: "a@jellymatch.tech" })
      ).rejects.toThrow(EMAIL_SENDER_ERRORS.noDomain);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it("rejects an address outside the allowed domain", async () => {
      const { service, repository } = setup();
      await expect(
        service.update({ organizationId: ORG_ID, actorUserId: 1, senderAddress: "a@other.jellymatch.tech" })
      ).rejects.toThrow(EMAIL_SENDER_ERRORS.domainNotAllowed);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe("resolveForScope", () => {
    it.each([
      ["organizationId", { organizationId: ORG_ID }, null],
      ["teamId", { teamId: 3 }, "findOrganizationIdByTeamId"],
      ["userId", { userId: 4 }, "findOrganizationIdByUserId"],
      ["userEmail", { userEmail: "a@b.co" }, "findOrganizationIdByUserEmail"],
    ] as const)("resolves a %s scope", async (_name, scope, lookup) => {
      const { service, repository } = setup();
      await expect(service.resolveForScope(scope)).resolves.toEqual({
        name: "Jelly",
        address: "hello@jellymatch.tech",
      });
      if (lookup) expect(repository[lookup]).toHaveBeenCalled();
      expect(repository.findByOrganizationId).toHaveBeenCalledWith(ORG_ID);
    });

    it("returns null when no organization matches", async () => {
      const { service, repository } = setup();
      repository.findOrganizationIdByUserId.mockResolvedValue(null);
      await expect(service.resolveForScope({ userId: 9 })).resolves.toBeNull();
      expect(repository.findByOrganizationId).not.toHaveBeenCalled();
    });

    it("drops an address whose domain is no longer allowed", async () => {
      const { service } = setup({ record: makeRecord({ customDomain: "other.io" }) });
      await expect(service.resolveForScope({ organizationId: ORG_ID })).resolves.toEqual({
        name: "Jelly",
        address: null,
      });
    });

    it("returns null when neither name nor an active address remains", async () => {
      const { service } = setup({ record: makeRecord({ emailFromName: null, customDomain: null }) });
      await expect(service.resolveForScope({ organizationId: ORG_ID })).resolves.toBeNull();
    });

    it("propagates repository errors", async () => {
      const { service, repository } = setup();
      repository.findByOrganizationId.mockRejectedValue(new Error("db down"));
      await expect(service.resolveForScope({ organizationId: ORG_ID })).rejects.toThrow("db down");
    });

    describe("cache", () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it("serves repeated lookups from cache until it expires", async () => {
        const { service, repository } = setup();
        await service.resolveForScope({ teamId: 3 });
        await service.resolveForScope({ teamId: 3 });
        expect(repository.findByOrganizationId).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(60_001);
        await service.resolveForScope({ teamId: 3 });
        expect(repository.findByOrganizationId).toHaveBeenCalledTimes(2);
      });

      it("invalidates every scope of an organization on update", async () => {
        const { service, repository } = setup();
        await service.resolveForScope({ teamId: 3 });
        await service.resolveForScope({ userId: 4 });
        await service.update({ organizationId: ORG_ID, actorUserId: 1, senderName: "Other" });
        const callsBefore = repository.findByOrganizationId.mock.calls.length;
        await service.resolveForScope({ teamId: 3 });
        await service.resolveForScope({ userId: 4 });
        expect(repository.findByOrganizationId.mock.calls.length).toBe(callsBefore + 2);
      });
    });
  });
});
