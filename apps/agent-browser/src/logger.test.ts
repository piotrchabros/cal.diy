// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createLogger, redactUrl } from "./logger";

describe("createLogger", () => {
  it("drops lines below the configured level and merges child fields", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", base: { app: "ab" }, write: (line) => lines.push(line) });

    logger.debug("hidden");
    logger.child({ botId: "b1" }).warn("shown", { code: 7 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      app: "ab",
      botId: "b1",
      code: 7,
      level: "warn",
      message: "shown",
    });
  });

  it("writes nothing when silent", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "silent", write: (line) => lines.push(line) });

    logger.error("hidden");

    expect(lines).toEqual([]);
  });
});

describe("redactUrl", () => {
  it("keeps only the origin and path", () => {
    expect(redactUrl("https://user:pw@example.com:8443/a/b?q=secret#frag")).toBe(
      "https://example.com:8443/a/b"
    );
  });

  it("hides the body of non-http URLs and unparseable input", () => {
    expect(redactUrl("data:text/html,<script>secret</script>")).toBe("data:[redacted]");
    expect(redactUrl("not a url")).toBe("[unparseable url]");
  });
});
