import { closeSync, globSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { workspaceChannelPackages } from "./test/setup/workspace-channel-packages.js";

import { workflow } from "./src/internal/testing/workflow-vitest-plugin.js";

const INTEGRATION_TESTS = ["src/**/*.integration.test.ts", "test/**/*.integration.test.ts"];
const LINUX_ONLY_MARKER = "// @linux-only:";

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
  const root = fileURLToPath(new URL(".", import.meta.url));
  const head = Buffer.alloc(512);
  return globSync(INTEGRATION_TESTS, { cwd: root })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => {
      const fd = openSync(root + file, "r");
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
    exclude: [
      "**/node_modules/**",
      "test/scenarios/**",
      // Windows runs only the tests whose behavior can differ there; see linuxOnlyIntegrationTests.
      // Channel conformance checks platform protocol, not the OS.
      ...(process.platform === "win32"
        ? ["**/conformance*.integration.test.ts", ...linuxOnlyTests]
        : []),
    ],
    globalSetup: ["./test/setup/clear-workflow-cache.ts"],
    include: INTEGRATION_TESTS,
    server: {
      deps: {
        // Imports matrix-js-sdk paths without file extensions, which Node's ESM loader rejects
        // and bundlers resolve; registry template tests load it through Vite instead.
        inline: [/@beeper\/chat-adapter-matrix/u],
        external: [/\.workflow-vitest[\\/]/],
      },
    },
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 30_000,
  },
});
