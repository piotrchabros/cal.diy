// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// This file holds the forbidden patterns and bad-import fixtures as string literals,
// so scanning it would make every rule report itself.
const SELF = "src/workspaceRules.test.ts";

const SCANNED_DIRECTORIES = ["src", "scripts"];
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "dist"]);

type SourceFile = { path: string; source: string };

function collectFiles(directory: string, found: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      collectFiles(absolute, found);
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(absolute);
  }
}

function listSourceFiles(): SourceFile[] {
  const absolutePaths: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) {
    collectFiles(path.join(WORKSPACE_ROOT, directory), absolutePaths);
  }
  return absolutePaths
    .map((absolute) => ({
      path: path.relative(WORKSPACE_ROOT, absolute).split(path.sep).join("/"),
      source: readFileSync(absolute, "utf8"),
    }))
    .filter((file) => file.path !== SELF)
    .sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path));
}

function isTestFile(filePath: string): boolean {
  return filePath.endsWith(".test.ts");
}

const STATIC_IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["'`]([^"'`\n]+)["'`]/g;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*["'`]([^"'`\n]+)["'`]/g;

// Comments are not stripped: a commented-out import still counts, the conservative choice.
function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

const ALLOWED_CALCOM_SPECIFIER = "@calcom/lib/notetaker/botContract";

function findForeignImports(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of extractImportSpecifiers(file.source)) {
      if (specifier === "@calcom" || specifier.startsWith("@calcom/")) {
        if (specifier !== ALLOWED_CALCOM_SPECIFIER) {
          violations.push(
            `${file.path}: imports "${specifier}"; the bot may only import ${ALLOWED_CALCOM_SPECIFIER} from @calcom`
          );
        }
        continue;
      }
      if (specifier.startsWith("/")) {
        violations.push(`${file.path}: imports absolute path "${specifier}"`);
        continue;
      }
      if (specifier.startsWith(".")) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier));
        if (resolved === ".." || resolved.startsWith("../")) {
          violations.push(`${file.path}: relative import "${specifier}" leaves the workspace`);
        }
      }
    }
  }
  return violations;
}

const DISK_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const DISK_WRITING_NEEDLES = ["recordVideo", "recordHar", "tracing.start", ".screenshot(", ".pdf("];

// No audio or video may ever be written to disk, so production code gets no filesystem
// access and no browser feature that persists media or traces.
function findDiskAccess(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith("src/") || isTestFile(file.path)) continue;
    for (const specifier of extractImportSpecifiers(file.source)) {
      if (DISK_MODULES.has(specifier)) {
        violations.push(`${file.path}: imports "${specifier}"; production code must not touch the disk`);
      }
    }
    for (const needle of DISK_WRITING_NEEDLES) {
      if (file.source.includes(needle)) {
        violations.push(`${file.path}: contains "${needle}", which can write media or traces to disk`);
      }
    }
  }
  return violations;
}

const PLAYWRIGHT_SPECIFIER = /^(?:@playwright\/|playwright(?:-core)?(?:\/|$))/;
const PLAYWRIGHT_LAUNCHER = "src/platform/browser/PlaywrightChromeLauncher.ts";

function findPlaywrightImports(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (file.path === PLAYWRIGHT_LAUNCHER || file.path.startsWith("scripts/")) continue;
    for (const specifier of extractImportSpecifiers(file.source)) {
      if (PLAYWRIGHT_SPECIFIER.test(specifier)) {
        violations.push(
          `${file.path}: imports "${specifier}"; only ${PLAYWRIGHT_LAUNCHER} may import Playwright`
        );
      }
    }
  }
  return violations;
}

const ENV_ACCESS = /\bprocess\s*\.\s*env\b/;
const ENV_ALLOWED_PATHS = new Set(["src/config.ts", "src/main.ts", "src/runnerMain.ts"]);

function findEnvAccess(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (ENV_ALLOWED_PATHS.has(file.path) || file.path.startsWith("scripts/")) continue;
    if (ENV_ACCESS.test(file.source)) {
      violations.push(`${file.path}: reads process.env; only config.ts, main.ts and runnerMain.ts may`);
    }
  }
  return violations;
}

const MARKER = "UNVERIFIED AGAINST THE REAL SERVICE";

// These files were written without access to the real service they talk to; the marker
// may only be removed after a manual check against that service.
const MARKED_FILES = [
  "src/audio/captureScript.ts",
  "src/stt/sonioxProtocol.ts",
  "src/stt/SonioxRealtimeProvider.ts",
  "src/speakers/SpeakerAttributor.ts",
  "src/platform/browser/PlaywrightChromeLauncher.ts",
  "src/platform/browser/BrowserPlatformAdapter.ts",
  "src/platform/GoogleMeetAdapter.ts",
  "src/platform/MicrosoftTeamsAdapter.ts",
  "src/runner/launcher/DockerEngineClient.ts",
  "src/runner/launcher/DockerMeetingRunnerLauncher.ts",
  "Dockerfile",
  "scripts/spike-speaker-attribution.ts",
  "scripts/capture-smoke.ts",
  "scripts/capture-google-storage-state.ts",
  "scripts/meet-probe.ts",
  "scripts/meetProbePageScript.ts",
];

function findMissingMarkers(read: (relativePath: string) => string | null): string[] {
  const violations: string[] = [];
  for (const markedPath of MARKED_FILES) {
    const source = read(markedPath);
    if (source === null) continue;
    if (!source.includes(MARKER)) {
      violations.push(`${markedPath}: missing the "${MARKER}" marker; remove it only after a manual check`);
    }
  }
  return violations;
}

function file(filePath: string, source: string): SourceFile {
  return { path: filePath, source };
}

describe("workspace rules", () => {
  it("walks the real workspace from the right root", () => {
    const paths = listSourceFiles().map((f) => f.path);
    expect(paths).toContain("src/logger.ts");
    expect(paths).toContain("src/audio/AudioFrame.ts");
    expect(paths).toContain("src/testing/httpTestKit.ts");
    expect(paths).toContain("src/logger.test.ts");
    expect(paths).not.toContain(SELF);
  });

  describe("import specifier extraction", () => {
    it("finds default, multi-line, type, namespace and side-effect imports", () => {
      expect(extractImportSpecifiers(`import x from "a";`)).toEqual(["a"]);
      expect(extractImportSpecifiers(`import {\n  a,\n  b,\n} from "b";`)).toEqual(["b"]);
      expect(extractImportSpecifiers(`import type { T } from "c";`)).toEqual(["c"]);
      expect(extractImportSpecifiers(`import * as ns from "d";`)).toEqual(["d"]);
      expect(extractImportSpecifiers(`import "e";`)).toEqual(["e"]);
    });

    it("finds re-exports", () => {
      expect(extractImportSpecifiers(`export { a } from "f";`)).toEqual(["f"]);
      expect(extractImportSpecifiers(`export * from "g";`)).toEqual(["g"]);
      expect(extractImportSpecifiers(`export type { T } from "h";`)).toEqual(["h"]);
    });

    it("finds dynamic imports, require and type-position imports", () => {
      expect(extractImportSpecifiers(`const m = await import("i");`)).toEqual(["i"]);
      expect(extractImportSpecifiers(`const m = require("j");`)).toEqual(["j"]);
      expect(extractImportSpecifiers(`let s: import("node:http").Server;`)).toEqual(["node:http"]);
    });

    it("ignores exports that only contain string literals", () => {
      expect(extractImportSpecifiers(`export const X = "y";`)).toEqual([]);
      expect(extractImportSpecifiers(`export type T = A["k"];`)).toEqual([]);
    });

    it("deduplicates specifiers found by both patterns", () => {
      expect(extractImportSpecifiers(`import "k";\nawait import("k");`)).toEqual(["k"]);
    });
  });

  describe("rule 1: no imports from outside the workspace", () => {
    it("holds for the real tree", () => {
      expect(findForeignImports(listSourceFiles())).toEqual([]);
    });

    it("flags forbidden @calcom, absolute and workspace-escaping imports", () => {
      const files = [
        file("src/a.ts", `import { x } from "@calcom/features/x";`),
        file("src/b.ts", `import { x } from "@calcom/trpc/server";`),
        file("src/c.ts", `import { x } from "@calcom/prisma";`),
        file("src/d.ts", `import { x } from "@calcom/lib/logger";`),
        file("src/e.ts", `import { x } from "../../packages/lib/x";`),
        file("src/f.ts", `const m = require("@calcom/web/x");`),
        file("src/g.ts", `let v: import("@calcom/prisma").X;`),
        file("src/h.ts", `import { x } from "/etc/passwd";`),
        file("src/i.ts", `import { x } from "@calcom";`),
      ];
      const violations = findForeignImports(files);
      expect(violations).toHaveLength(files.length);
      for (const f of files) {
        expect(violations.some((v) => v.startsWith(`${f.path}: `))).toBe(true);
      }
    });

    it("allows the bot contract, in-workspace relative imports and third-party modules", () => {
      const files = [
        file("src/a.ts", `import type { C } from "@calcom/lib/notetaker/botContract";`),
        file("src/audio/a.ts", `import { x } from "../logger";`),
        file("src/b.ts", `import { createServer } from "node:http";`),
        file("src/c.ts", `import WebSocket from "ws";`),
        file("src/d.ts", `import { z } from "zod";`),
      ];
      expect(findForeignImports(files)).toEqual([]);
    });
  });

  describe("rule 2: no disk access in production code", () => {
    it("holds for the real tree", () => {
      expect(findDiskAccess(listSourceFiles())).toEqual([]);
    });

    it("flags filesystem modules", () => {
      for (const specifier of ["fs", "node:fs", "fs/promises", "node:fs/promises"]) {
        const violations = findDiskAccess([file("src/x.ts", `import * as fs from "${specifier}";`)]);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toContain("src/x.ts");
      }
    });

    it("flags browser features that persist media or traces", () => {
      for (const needle of ["recordVideo", "recordHar", "tracing.start", ".screenshot(", ".pdf("]) {
        const violations = findDiskAccess([file("src/x.ts", `await context.${needle} // x`)]);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toContain(needle);
      }
    });

    it("does not apply to tests, scripts or network-only helpers", () => {
      const files = [
        file("src/x.test.ts", `import fs from "node:fs";\npage.screenshot({});`),
        file("scripts/x.ts", `import fs from "node:fs";\npage.screenshot({});`),
        file("src/testing/httpTestKit.ts", `import { createServer } from "node:http";`),
      ];
      expect(findDiskAccess(files)).toEqual([]);
    });
  });

  describe("rule 3: Playwright is confined to the launcher", () => {
    it("holds for the real tree", () => {
      expect(findPlaywrightImports(listSourceFiles())).toEqual([]);
    });

    it("flags Playwright imports outside the launcher and scripts", () => {
      const files = [
        file("src/platform/GoogleMeetAdapter.ts", `import { chromium } from "playwright";`),
        file("src/x.test.ts", `import { chromium } from "playwright-core";`),
        file("src/platform/browser/MeetingPage.ts", `let p: import("playwright").Page;`),
      ];
      const violations = findPlaywrightImports(files);
      expect(violations).toHaveLength(3);
      for (const f of files) {
        expect(violations.some((v) => v.startsWith(`${f.path}: `))).toBe(true);
      }
    });

    it("allows the launcher and scripts", () => {
      const files = [
        file(
          "src/platform/browser/PlaywrightChromeLauncher.ts",
          `import { chromium } from "playwright-core";`
        ),
        file("scripts/capture-smoke.ts", `import { chromium } from "playwright";`),
      ];
      expect(findPlaywrightImports(files)).toEqual([]);
    });
  });

  describe("rule 4: environment is read only at the entry points", () => {
    it("holds for the real tree", () => {
      expect(findEnvAccess(listSourceFiles())).toEqual([]);
    });

    it("flags process.env outside the allowed files, tests included", () => {
      const files = [
        file("src/server.ts", `const port = process.env.PORT;`),
        file("src/config.test.ts", `process . env.X = "1";`),
      ];
      const violations = findEnvAccess(files);
      expect(violations).toHaveLength(2);
      expect(violations[0]).toContain("src/server.ts");
      expect(violations[1]).toContain("src/config.test.ts");
    });

    it("allows the entry points and scripts", () => {
      const source = `const port = process.env.PORT;`;
      const files = [
        file("src/config.ts", source),
        file("src/main.ts", source),
        file("src/runnerMain.ts", source),
        file("scripts/fake-events.ts", source),
      ];
      expect(findEnvAccess(files)).toEqual([]);
    });

    it("ignores lookalikes that do not read the environment", () => {
      const files = [
        file("src/a.ts", `type E = NodeJS.ProcessEnv;`),
        file("src/b.ts", `const bin = process.execPath;`),
      ];
      expect(findEnvAccess(files)).toEqual([]);
    });
  });

  describe("rule 5: unverified files carry their marker", () => {
    it("holds for the real tree", () => {
      const read = (relativePath: string): string | null => {
        const absolute = path.join(WORKSPACE_ROOT, relativePath);
        return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
      };
      expect(findMissingMarkers(read)).toEqual([]);
    });

    it("skips files that do not exist", () => {
      expect(findMissingMarkers(() => null)).toEqual([]);
    });

    it("flags a present file without the marker", () => {
      const read = (relativePath: string): string | null =>
        relativePath === "src/stt/sonioxProtocol.ts" ? "export const X = 1;\n" : null;
      const violations = findMissingMarkers(read);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("src/stt/sonioxProtocol.ts");
    });

    it("accepts a present file with the marker", () => {
      const read = (relativePath: string): string | null =>
        relativePath === "src/stt/sonioxProtocol.ts" ? `// ${MARKER}\nexport const X = 1;\n` : null;
      expect(findMissingMarkers(read)).toEqual([]);
    });

    it("accepts a Dockerfile that carries the marker in comments", () => {
      const read = (relativePath: string): string | null =>
        relativePath === "Dockerfile" ? `# ${MARKER}\n# remove after a manual check\nFROM node:22\n` : null;
      expect(findMissingMarkers(read)).toEqual([]);
    });
  });
});
