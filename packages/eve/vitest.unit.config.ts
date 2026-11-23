import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { workspaceChannelPackages } from "./test/setup/workspace-channel-packages.js";
import { SHARED_STATE_USE } from "./test/setup/shared-state-use.js";

function isolatedFiles(): string[] {
  const files = unitTestFiles();

  const alwaysIsolated = new Set([
    "src/cli/commands/set.test.ts",
    "src/execution/hosts.test.ts",
    "src/execution/workflow-runtime-host.test.ts",
    "src/internal/workflow/builtins-host.test.ts",
    "src/public/memory/index.test.ts",
    "src/runtime/attributes/emit.drift.test.ts",
    "src/setup/package-manager.test.ts",
  ]);

  for (const file of alwaysIsolated) {
    if (!files.includes(file)) {
      throw new Error(
        `vitest.unit.config.ts lists ${file} as isolated, but no such unit test exists.`,
      );
    }
  }

  return files.filter(
    (file) =>
      alwaysIsolated.has(file) || SHARED_STATE_USE.test(readFileSync(join(ROOT, file), "utf8")),
  );
}

const ROOT = fileURLToPath(new URL(".", import.meta.url));

function unitTestFiles(): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.some((excluded) => `${path}/`.startsWith(excluded))) walk(path);
      } else if (entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };

  walk("src");
  walk("test");

  return found.filter(
    (file) => !file.endsWith(".integration.test.ts") && !file.endsWith(".scenario.test.ts"),
  );
}

const EXCLUDED_DIRECTORIES = ["test/browser/", "test/framework-fixtures/", "test/scenarios/"];

const isolated = isolatedFiles();

const shared = {
  env: { EVE_CHECK_SESSION_EVENTS: "1" },
  environment: "node",
  exclude: [
    "**/node_modules/**",
    "src/**/*.integration.test.ts",
    "src/**/*.scenario.test.ts",
    "test/**/*.integration.test.ts",
    "test/browser/**",
    "test/framework-fixtures/**",
    "test/scenarios/**",
  ],
  pool: "threads" as const,
  setupFiles: [
    "./src/internal/testing/reset-test-realm.ts",
    "./src/internal/testing/unit-guard.ts",
    "./test/setup/mock-ai-gateway.ts",
  ],
  testTimeout: 5_000,
};

export default defineConfig({
  resolve: {
    alias: [
      ...workspaceChannelPackages,
      {
        find: /^solid-js$/,
        replacement: join(
          dirname(createRequire(import.meta.url).resolve("solid-js/package.json")),
          "dist/solid.js",
        ),
      },
      {
        find: /^eve\/instrumentation\/otel$/,
        replacement: new URL("./src/public/instrumentation/otel.ts", import.meta.url).pathname,
      },
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
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: "unit-isolated",
          include: isolated,
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: "unit-shared",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [...shared.exclude, ...isolated],
          isolate: false,
          setupFiles: [...shared.setupFiles, "./test/setup/shared-state-guard.ts"],
        },
      },
    ],
  },
});
