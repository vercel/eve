import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { workspaceChannelPackages } from "./test/setup/workspace-channel-packages.js";

/**
 * Tier 0 — Unit tests.
 *
 * Fast, hermetic tests that exercise a single module (or a small set of
 * modules) with every external boundary stubbed via `vi.mock`. Tests loaded by
 * this config must not touch the real filesystem (writes), spawn processes,
 * mutate `process.env`/`process.cwd`, or make real network requests. The
 * `unit-guard.ts` setup file replaces these surfaces with throwing stubs so
 * violations surface as a loud error that points the author at the integration
 * or scenario tier.
 *
 * Default timeout is deliberately tight so accidental I/O or async hangs fail
 * fast.
 *
 * The tier runs as two projects. A file that mocks a module, stubs a global,
 * fakes timers, or writes `process.env` keeps its own module graph, because
 * `vi.mock` only applies to a module the worker has not imported yet. Every
 * other file shares the worker's already imported graph, which is where the
 * tier's import time goes. Both projects share one worker budget: they use the
 * default `sequence.groupOrder`, so vitest runs them as one group. See
 * `test/setup/shared-state-guard.ts` for the check that a shared file leaves no
 * state behind.
 */

/** Files that keep their own worker and module graph. */
function isolatedFiles(): string[] {
  const files = unitTestFiles();

  // A test that expects a fresh process — an empty host registry, a first
  // import, a count of zero — cannot share a worker with anything.
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

/** `vi.mock`-style calls, module graph resets, and process-wide writes that outlive a test file. */
const SHARED_STATE_USE =
  /\bvi\.(?:mock|doMock|resetModules|stubGlobal|stubEnv|useFakeTimers|setSystemTime)\(|process\.env(?:\.\w+|\[[^\]]+\])\s*(?:=|\+=)|process\.chdir\(/;

/** This package's directory. */
const ROOT = fileURLToPath(new URL(".", import.meta.url));

/** Unit test files, relative to {@link ROOT} with `/` separators, as vitest's `include` takes them. */
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
  // As in integration: a session a test drives fails on a line readers couldn't fold.
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
  // Worker threads start in a fraction of the time a forked process needs.
  pool: "threads" as const,
  setupFiles: [
    "./src/internal/testing/reset-unit-realm.ts",
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
