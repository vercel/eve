import { closeSync, globSync, openSync, readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { SHARED_STATE_USE } from "./test/setup/shared-state-use.js";
import { workspaceChannelPackages } from "./test/setup/workspace-channel-packages.js";

import { workflow } from "./src/internal/testing/workflow-vitest-plugin.js";

const INTEGRATION_TESTS = ["src/**/*.integration.test.ts", "test/**/*.integration.test.ts"];
const LINUX_ONLY_MARKER = "// @linux-only:";
const ROOT = fileURLToPath(new URL(".", import.meta.url));

function integrationTestFiles(): string[] {
  return globSync(INTEGRATION_TESTS, { cwd: ROOT }).map((file) => file.replaceAll("\\", "/"));
}

function linuxOnlyIntegrationTests(): string[] {
  const head = Buffer.alloc(512);
  return integrationTestFiles()
    .filter((file) => {
      const fd = openSync(ROOT + file, "r");
      const firstLine = head.toString("utf8", 0, readSync(fd, head, 0, head.length, 0));
      closeSync(fd);
      if (!firstLine.startsWith(LINUX_ONLY_MARKER)) return false;
      const reason = firstLine.slice(LINUX_ONLY_MARKER.length).split("\n", 1)[0]!.trim();
      if (reason === "") throw new Error(`${file} is marked Linux-only without a reason.`);
      return true;
    })
    .sort();
}

const linuxOnlyTests = linuxOnlyIntegrationTests();

function isolatedIntegrationTests(): string[] {
  const files = integrationTestFiles();

  const alwaysIsolated = new Set([
    "src/internal/workflow/local-world-stream-reads.integration.test.ts",
  ]);

  for (const file of alwaysIsolated) {
    if (!files.includes(file)) {
      throw new Error(
        `vitest.integration.config.ts lists ${file} as isolated, but no such integration test exists.`,
      );
    }
  }

  return files
    .filter(
      (file) =>
        alwaysIsolated.has(file) || SHARED_STATE_USE.test(readFileSync(ROOT + file, "utf8")),
    )
    .sort();
}

const isolatedTests = isolatedIntegrationTests();

const EXCLUDE = [
  "**/node_modules/**",
  "test/scenarios/**",
  ...(process.platform === "win32"
    ? ["**/conformance*.integration.test.ts", ...linuxOnlyTests]
    : []),
];

const SETUP_FILES = ["./test/setup/mock-ai-gateway.ts", "./test/setup/workflow-setup.ts"];

export default defineConfig({
  plugins: [workflow()],
  resolve: {
    alias: [
      ...workspaceChannelPackages,
      {
        find: /^#compiled\/(.+)\.js$/,
        replacement: new URL("./.generated/compiled/$1.js", import.meta.url).pathname,
      },
      {
        find: /^#(.+)\.js$/,
        replacement: new URL("./src/$1.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    env: { EVE_CHECK_SESSION_EVENTS: "1" },
    environment: "node",
    globalSetup: ["./test/setup/clear-workflow-cache.ts"],
    server: {
      deps: {
        inline: [/@beeper\/chat-adapter-matrix/u],
        external: [/\.workflow-vitest[\\/]/],
      },
    },
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "integration-isolated",
          include: isolatedTests,
          exclude: EXCLUDE,
          setupFiles: ["./src/internal/testing/reset-test-realm.ts", ...SETUP_FILES],
        },
      },
      {
        extends: true,
        test: {
          name: "integration-shared",
          include: INTEGRATION_TESTS,
          exclude: [...EXCLUDE, ...isolatedTests],
          isolate: false,
          setupFiles: [
            "./src/internal/testing/reset-test-realm.ts",
            "./test/setup/shared-state-guard.ts",
            ...SETUP_FILES,
          ],
        },
      },
    ],
  },
});
