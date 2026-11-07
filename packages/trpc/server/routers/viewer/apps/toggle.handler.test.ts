import { AppCategories } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toggleHandler } from "./toggle.handler";

const { sendDisabledAppEmail, getBaseUrlForUser } = vi.hoisted(() => ({
  sendDisabledAppEmail: vi.fn(),
  getBaseUrlForUser: vi.fn(async ({ userId }: { userId: number }) => `https://org${userId}.example.com`),
}));

vi.mock("@calcom/emails/integration-email-service", () => ({ sendDisabledAppEmail }));
vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrlForUser }),
}));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn(async () => (key: string) => key) }));
vi.mock("@calcom/app-store/utils", () => ({
  getLocalAppMetadata: () => [{ slug: "some-app", dirName: "some-app", name: "Some App" }],
}));

const buildPrisma = (categories: AppCategories[]) => ({
  app: { upsert: vi.fn().mockResolvedValue({ slug: "some-app", enabled: false, categories }) },
  credential: {
    findMany: vi.fn().mockResolvedValue([{ user: { id: 5, email: "a@example.com", locale: "en" } }]),
  },
  eventType: {
    findMany: vi.fn().mockResolvedValue([
      {
        id: 9,
        title: "Paid call",
        metadata: { apps: { "some-app": { enabled: true } } },
        users: [{ id: 6, email: "b@example.com", locale: null }],
      },
    ]),
    update: vi.fn().mockResolvedValue({}),
  },
});

const run = (prisma: ReturnType<typeof buildPrisma>) =>
  toggleHandler({
    ctx: { user: {} as never, prisma: prisma as never },
    input: { slug: "some-app", enabled: false },
  });

describe("toggleHandler disabled-app emails", () => {
  beforeEach(() => {
    sendDisabledAppEmail.mockReset();
    getBaseUrlForUser.mockClear();
  });

  it("links credential owners to their own organization", async () => {
    await run(buildPrisma([AppCategories.video]));
    await vi.waitFor(() => expect(sendDisabledAppEmail).toHaveBeenCalled());

    expect(getBaseUrlForUser).toHaveBeenCalledWith({ userId: 5 });
    expect(sendDisabledAppEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "a@example.com", baseUrl: "https://org5.example.com" })
    );
  });

  it("links event type users to their own organization", async () => {
    await run(buildPrisma([AppCategories.payment]));
    await vi.waitFor(() => expect(sendDisabledAppEmail).toHaveBeenCalled());

    expect(getBaseUrlForUser).toHaveBeenCalledWith({ userId: 6 });
    expect(sendDisabledAppEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "b@example.com", eventTypeId: 9, baseUrl: "https://org6.example.com" })
    );
  });
});
