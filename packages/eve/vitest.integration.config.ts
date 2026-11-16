import { closeSync, globSync, openSync, readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { SHARED_STATE_USE } from "./test/setup/shared-state-use.js";
import { workspaceChannelPackages } from "./test/setup/workspace-channel-packages.js";

import { workflow } from "./src/internal/testing/workflow-vitest-plugin.js";

const INTEGRATION_TESTS = ["src/**/*.integration.test.ts", "test/**/*.integration.test.ts"];
const LINUX_ONLY_MARKER = "// @linux-only:";
const ROOT = fileURLToPath(new URL(".", import.meta.url));

/** Integration test files, relative to {@link ROOT} with `/` separators. */
function integrationTestFiles(): string[] {
  return globSync(INTEGRATION_TESTS, { cwd: ROOT }).map((file) => file.replaceAll("\\", "/"));
}

/**
 * The integration test files whose first line is `// @linux-only: <reason>`.
 *
 * Windows CI runs the integration tier to catch what differs on Windows: filesystem paths and
 * links, file watching, processes and signals, module resolution and loading, bundling, the CLI,
 * the dev host, and Workflow's local World on disk, which `eve dev` runs on. A file is marked
 * when it tests only agent and session behavior that is the same on every OS: the kernel, the
 * harness, and sessions compiled from memory, on the in-process host or on Workflow. On Windows,
 * the host battery's Workflow side and the local World, session store, and step bundle tests keep
 * Workflow's on-disk side covered.
 *
 * A file without the marker runs on Windows, so a new file is covered there until someone marks
 * it. Mark a file only when none of its tests touches anything Windows can change.
 */
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

// Scanned on every platform, so a marker without a reason fails on Linux CI too.
const linuxOnlyTests = linuxOnlyIntegrationTests();

/** Files that keep their own worker process and module graph. */
function isolatedIntegrationTests(): string[] {
  const files = integrationTestFiles();

  // Files that assert on what only a fresh process has.
  const alwaysIsolated = new Set([
    // Counts every `fs` call in the process, so work an earlier file left running miscounts it.
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
  // Windows runs only the tests whose behavior can differ there; see linuxOnlyIntegrationTests.
  // Channel conformance checks platform protocol, not the OS.
  ...(process.platform === "win32"
    ? ["**/conformance*.integration.test.ts", ...linuxOnlyTests]
    : []),
];

// The `workflow()` plugin adds these to the root config, which projects don't inherit.
const SETUP_FILES = ["./test/setup/mock-ai-gateway.ts", "./test/setup/workflow-setup.ts"];

/**
 * Tier 1 — Integration tests.
 *
 * Tests that exercise multiple eve modules together — typically through the
 * workflow SDK, the compiler, the discover pipeline, or the nitro routes —
 * without spawning subprocesses, binding real TCP ports, or shelling out to
 * the `eve` CLI. These tests may touch the filesystem (tmpdirs, generated
 * fixtures) and currently invoke the real compile pipeline while the
 * in-memory `AppHarness` (phase D) is under construction.
 *
 * If a test needs a subprocess, a real HTTP listener, or a real package
 * tarball install, move it to the scenario tier
 * (`test/scenarios/*.scenario.test.ts`).
 *
 * The tier runs as two projects, as the unit tier does. A file that mocks a
 * module, stubs a global, fakes timers, or writes `process.env` keeps its own
 * process and module graph. Every other file shares its worker's module graph
 * and the Workflow step bundle the worker loaded, which is most of a file's
 * fixed cost. A shared file starts as a new process would: an empty host
 * registry and instrumentation runtime, Workflow's process-wide caches empty,
 * and its own World, which reinstalls Workflow's host as it loads the bundle.
 * `test/setup/shared-state-guard.ts` fails a shared file that leaves
 * process-wide state behind.
 */
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
    // Every line a session publishes is checked against the event contract, so a test that
    // drives a session also fails on a fact a reader couldn't fold.
    env: { EVE_CHECK_SESSION_EVENTS: "1" },
    environment: "node",
    globalSetup: ["./test/setup/clear-workflow-cache.ts"],
    server: {
      deps: {
        // Imports matrix-js-sdk paths without file extensions, which Node's ESM loader rejects
        // and bundlers resolve; registry template tests load it through Vite instead.
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
          // First, so the guard's `afterAll` runs after `workflow-setup.ts` closed the file's World.
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
