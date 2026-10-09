import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20000,
    server: { deps: { inline: [/@calcom\/.*/] } },
  },
});
