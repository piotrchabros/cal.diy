import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, describe, expect, it, vi } from "vitest";

const sendNotification = vi.fn();
const getBaseUrl = vi.fn();

vi.mock("@calcom/features/notifications/sendNotification", () => ({
  sendNotification,
}));

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl }),
}));

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn().mockResolvedValue((key: string) => key),
}));

vi.mock("@calcom/prisma", () => ({
  default: {
    notificationsSubscriptions: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

const ORG_URL = "https://acme.cal.example";

const callHandler = async (organizationId: number | null) => {
  const { addNotificationsSubscriptionHandler } = await import("./addNotificationsSubscription.handler");

  await addNotificationsSubscriptionHandler({
    ctx: {
      user: {
        id: 1,
        locale: "en",
        organizationId,
      } as never,
    },
    input: {
      subscription: JSON.stringify({
        endpoint: "https://example.com/push",
        keys: {
          auth: "auth",
          p256dh: "p256dh",
        },
      }),
    },
  });
};

describe("addNotificationsSubscriptionHandler", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("uses WEBAPP_URL for the test notification link when the user has no organization", async () => {
    getBaseUrl.mockResolvedValue(WEBAPP_URL);

    await callHandler(null);

    expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: null });
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        url: WEBAPP_URL,
        title: "test_notification_title",
        body: "test_notification_body",
      })
    );
  });

  it("uses the user's organization base URL for the test notification link", async () => {
    getBaseUrl.mockResolvedValue(ORG_URL);

    await callHandler(42);

    expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: 42 });
    expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ url: ORG_URL }));
  });
});
