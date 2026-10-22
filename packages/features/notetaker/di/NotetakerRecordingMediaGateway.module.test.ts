/** @vitest-environment node */

import { describe, expect, it, vi } from "vitest";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { RecallRecordingMediaGateway } from "../bot/recall/RecallRecordingMediaGateway";
import { getNotetakerConfig } from "../lib/config";
import {
  createNotetakerRecordingMediaGatewayResolver,
  moduleLoader,
} from "./NotetakerRecordingMediaGateway.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const RECALL_ENV = {
  NODE_ENV: "test",
  NOTETAKER_BOT_PROVIDER: "recall",
  RECALL_API_KEY: "key-123",
  RECALL_WEBHOOK_VERIFICATION_SECRET: "whsec_c2VjcmV0LWtleS1ieXRlcw==",
} satisfies NodeJS.ProcessEnv;

function create(env: NodeJS.ProcessEnv) {
  const getRecallClient = vi.fn(() => ({}) as IRecallApiClient);
  const resolver = createNotetakerRecordingMediaGatewayResolver({
    config: getNotetakerConfig(env),
    getRecallClient,
  });
  return { resolver, getRecallClient };
}

describe("createNotetakerRecordingMediaGatewayResolver", () => {
  it("returns null without constructing the client when Recall is unconfigured", () => {
    const { resolver, getRecallClient } = create({ NODE_ENV: "test" });

    expect(resolver.forProvider("RECALL")).toBeNull();
    expect(getRecallClient).not.toHaveBeenCalled();
  });

  it("returns a Recall gateway for RECALL when Recall is configured", () => {
    const { resolver, getRecallClient } = create(RECALL_ENV);

    expect(resolver.forProvider("RECALL")).toBeInstanceOf(RecallRecordingMediaGateway);
    expect(getRecallClient).toHaveBeenCalledTimes(1);
  });

  it("returns null for other providers even when Recall is configured", () => {
    const { resolver, getRecallClient } = create(RECALL_ENV);

    expect(resolver.forProvider("SELF_HOSTED")).toBeNull();
    expect(resolver.forProvider("FAKE")).toBeNull();
    expect(getRecallClient).not.toHaveBeenCalled();
  });
});

describe("moduleLoader", () => {
  it("binds the recording media gateway resolver token", () => {
    expect(moduleLoader.token).toBe(NOTETAKER_DI_TOKENS.NOTETAKER_RECORDING_MEDIA_GATEWAY_RESOLVER);
  });
});
