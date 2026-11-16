import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import {
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
} from "./dev-server-descriptors.js";
import {
  fetchAgentInfo,
  forceDevelopmentRebuild,
  readDevelopmentRevision,
  type RunningEveDev,
  startEveDev,
  waitForCondition,
} from "#internal/testing/dev-server-harness.js";

describe("eve dev server build recovery", () => {
  // These tests only add or remove their own files, so they share one server.
  describe("on a shared server", () => {
    let appRoot: string;
    let cleanupSharedApp: (() => Promise<void>) | undefined;
    let server: RunningEveDev;

    beforeAll(async () => {
      const app = await materializeScenarioApp(TRANSACTIONAL_REBUILD_DESCRIPTOR);
      appRoot = app.appRoot;
      try {
        server = await startEveDev(appRoot);
      } catch (error) {
        await app.cleanup();
        throw error;
      }
      cleanupSharedApp = app.cleanup;
    }, DEV_SERVER_SCENARIO_TIMEOUT_MS);

    afterAll(async () => {
      await server?.stop();
      await cleanupSharedApp?.();
    }, DEV_SERVER_SCENARIO_TIMEOUT_MS);

    /** Server output written from now on. */
    function outputFromNow(): () => string {
      const stdoutStart = server.stdout().length;
      const stderrStart = server.stderr().length;
      return () => `${server.stdout().slice(stdoutStart)}\n${server.stderr().slice(stderrStart)}`;
    }

    it(
      "fails a build that never settles, then builds with the current .env",
      async () => {
        const output = outputFromNow();
        const stallPath = join(appRoot, "agent", "tools", "stall_probe.ts");

        const initialRevision = await readDevelopmentRevision(server.url);

        await writeFile(
          stallPath,
          [
            "await new Promise(() => {});",
            'import { defineTool } from "eve/tools";',
            'import { z } from "zod";',
            "export default defineTool({",
            '  description: "Never builds.",',
            "  inputSchema: z.object({}),",
            '  execute: async () => "ok",',
            "});",
            "",
          ].join("\n"),
        );
        await forceDevelopmentRebuild(server.url);
        await waitForCondition(
          async () => output().includes("awaits a promise that never settles"),
          () => `Timed out waiting for the stalled build to fail.\n\n${output()}`,
        );
        await expect(readDevelopmentRevision(server.url)).resolves.toBe(initialRevision);

        // Converges on the latest files, so intermediate watcher rebuilds cannot make it flaky.
        const probeDescription = async () =>
          (await fetchAgentInfo(server.url)).tools.static.find((tool) => tool.name === "env_probe")
            ?.description;
        await rm(stallPath);
        await writeFile(join(appRoot, ".env"), "EVE_SCENARIO_BUILD_VALUE=from-env\n");
        await writeFile(
          join(appRoot, "agent", "tools", "env_probe.ts"),
          [
            'import { defineTool } from "eve/tools";',
            'import { z } from "zod";',
            "export default defineTool({",
            '  description: `build saw ${process.env.EVE_SCENARIO_BUILD_VALUE ?? "nothing"}`,',
            "  inputSchema: z.object({}),",
            '  execute: async () => "ok",',
            "});",
            "",
          ].join("\n"),
        );
        await forceDevelopmentRebuild(server.url);
        await waitForCondition(
          async () => (await probeDescription()) === "build saw from-env",
          () => `Timed out waiting for the build to see .env.\n\n${output()}`,
        );

        await rm(join(appRoot, ".env"));
        await forceDevelopmentRebuild(server.url);
        await waitForCondition(
          async () => (await probeDescription()) === "build saw nothing",
          () => `Timed out waiting for the build without .env.\n\n${output()}`,
        );
      },
      DEV_SERVER_SCENARIO_TIMEOUT_MS,
    );
  });
});
