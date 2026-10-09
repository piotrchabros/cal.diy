import { randomUUID } from "node:crypto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerBotEvent, NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { notetakerBotJoinRequestSchema } from "@calcom/lib/notetaker/botContract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotetakerConfig } from "../lib/config";
import { getNotetakerConfig } from "../lib/config";
import { FakeBotGateway } from "./FakeBotGateway";
import type { NotetakerBotEventSink } from "./INotetakerBotGateway";
import { NotetakerBotGatewayFactory } from "./NotetakerBotGatewayFactory";
import { SelfHostedBotGateway } from "./SelfHostedBotGateway";

const BOT_URL = "https://bot.internal.example.com/v1";
const BOT_SECRET = "s3cr3t-token-value";

function buildConfig(overrides: Partial<NotetakerConfig>): NotetakerConfig {
  return { ...getNotetakerConfig({}), ...overrides };
}

function buildJoinRequest(): NotetakerBotJoinRequest {
  return notetakerBotJoinRequestSchema.parse({
    sessionId: randomUUID(),
    platform: "GOOGLE_MEET",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "Cal.diy Notetaker",
    noticeMessage: "This meeting is being transcribed.",
    scheduledStartAt: "2030-01-01T10:00:00.000Z",
    callbackUrl: "https://example.com/api/notetaker/events",
    limits: {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 900,
      aloneTimeoutSeconds: 300,
      maxDurationSeconds: 7200,
    },
  });
}

function createFactory(config: NotetakerConfig, eventSink: NotetakerBotEventSink = async () => {}) {
  return new NotetakerBotGatewayFactory({ config, eventSink });
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe("NotetakerBotGatewayFactory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the fake gateway for FAKE outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    const { gateway, provider } = createFactory(buildConfig({ botProvider: "FAKE" })).create();

    expect(provider).toBe("FAKE");
    expect(gateway).toBeInstanceOf(FakeBotGateway);
  });

  it("passes the configured scenario and the event sink to the fake gateway", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const events: NotetakerBotEvent[] = [];
    const eventSink: NotetakerBotEventSink = async (event) => {
      events.push(event);
    };
    const { gateway } = createFactory(
      buildConfig({ botProvider: "FAKE", fakeScenario: "not_admitted" }),
      eventSink
    ).create();
    if (!(gateway instanceof FakeBotGateway)) throw new Error("expected a FakeBotGateway");

    await gateway.requestJoin(buildJoinRequest());
    await gateway.whenIdle();

    expect(events.map((event) => event.type)).toEqual(["session.join_requested", "session.ended"]);
    const ended = events.at(-1);
    if (ended?.type !== "session.ended") throw new Error("expected a session.ended event");
    expect(ended.data.endReason).toBe("NOT_ADMITTED");
  });

  it("builds the self-hosted gateway when URL and secret are present", () => {
    const { gateway, provider } = createFactory(
      buildConfig({ botProvider: "SELF_HOSTED", botUrl: BOT_URL, botSecret: BOT_SECRET })
    ).create();

    expect(provider).toBe("SELF_HOSTED");
    expect(gateway).toBeInstanceOf(SelfHostedBotGateway);
  });

  it("defaults to the fake gateway outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    const config = getNotetakerConfig({ NODE_ENV: "test" });
    expect(config.botProvider).toBe("FAKE");

    const { gateway, provider } = createFactory(config).create();

    expect(provider).toBe("FAKE");
    expect(gateway).toBeInstanceOf(FakeBotGateway);
  });

  it("throws when no provider is configured in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const config = getNotetakerConfig({ NODE_ENV: "production" });
    expect(config.botProvider).toBeNull();

    const error = captureError(() => createFactory(config).create());

    expect(error).toBeInstanceOf(ErrorWithCode);
  });

  it("refuses the fake gateway in production without NEXT_PUBLIC_IS_E2E", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_IS_E2E", "");

    const error = captureError(() => createFactory(buildConfig({ botProvider: "FAKE" })).create());

    expect(error).toBeInstanceOf(ErrorWithCode);
  });

  it("allows the fake gateway in production when NEXT_PUBLIC_IS_E2E is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_IS_E2E", "1");

    const { gateway, provider } = createFactory(buildConfig({ botProvider: "FAKE" })).create();

    expect(provider).toBe("FAKE");
    expect(gateway).toBeInstanceOf(FakeBotGateway);
  });

  it.each(["production", "test"])("throws for RECALL when NODE_ENV is %s", (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);

    const error = captureError(() => createFactory(buildConfig({ botProvider: "RECALL" })).create());

    expect(error).toBeInstanceOf(ErrorWithCode);
  });

  it("throws for SELF_HOSTED without a URL", () => {
    const error = captureError(() =>
      createFactory(buildConfig({ botProvider: "SELF_HOSTED", botUrl: null, botSecret: BOT_SECRET })).create()
    );

    expect(error).toBeInstanceOf(ErrorWithCode);
  });

  it("throws for SELF_HOSTED without a secret", () => {
    const error = captureError(() =>
      createFactory(buildConfig({ botProvider: "SELF_HOSTED", botUrl: BOT_URL, botSecret: null })).create()
    );

    expect(error).toBeInstanceOf(ErrorWithCode);
  });

  it("never leaks the secret or URL in error messages", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_IS_E2E", "");
    const configs: NotetakerConfig[] = [
      buildConfig({ botProvider: null, botUrl: BOT_URL, botSecret: BOT_SECRET }),
      buildConfig({ botProvider: "RECALL", botUrl: BOT_URL, botSecret: BOT_SECRET }),
      buildConfig({ botProvider: "FAKE", botUrl: BOT_URL, botSecret: BOT_SECRET }),
      buildConfig({ botProvider: "SELF_HOSTED", botUrl: null, botSecret: BOT_SECRET }),
      buildConfig({ botProvider: "SELF_HOSTED", botUrl: BOT_URL, botSecret: null }),
    ];

    for (const config of configs) {
      const error = captureError(() => createFactory(config).create());
      if (!(error instanceof ErrorWithCode)) throw new Error("expected an ErrorWithCode");
      expect(error.message).not.toContain(BOT_SECRET);
      expect(error.message).not.toContain(BOT_URL);
      expect(error.message).not.toContain("bot.internal.example.com");
    }
  });
});
