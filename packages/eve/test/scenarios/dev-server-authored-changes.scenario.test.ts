import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STRUCTURAL_RELOAD_LOG_LINE } from "../../src/internal/nitro/host/dev-watcher-log.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
} from "./dev-server-descriptors.js";
import {
  createGenerationMarkerToolSource,
  readCompletedMessages,
} from "./dev-server-generation-tools.js";
import {
  fetchAgentInfo,
  fetchText,
  forceDevelopmentRebuild,
  hasKnownDevServerFailure,
  readDevelopmentRevision,
  type RunningEveDev,
  startEveDev,
} from "#internal/testing/dev-server-harness.js";

describe("eve dev server authored changes", () => {
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
      "publishes authored tool removals on a fresh worker without rebuilding the host",
      async () => {
        const output = outputFromNow();
        const initialRevision = await readDevelopmentRevision(server.url);
        const initialWorkerId = await fetchText(server.url, "/worker-id");
        expect((await fetchAgentInfo(server.url)).tools.static.map((tool) => tool.name)).toContain(
          "get_weather",
        );

        await rm(join(appRoot, "agent", "tools", "get_weather.ts"));
        await forceDevelopmentRebuild(server.url);

        await expect(readDevelopmentRevision(server.url)).resolves.not.toBe(initialRevision);
        await expect(fetchText(server.url, "/worker-id")).resolves.not.toBe(initialWorkerId);
        expect(output()).not.toContain(STRUCTURAL_RELOAD_LOG_LINE);
        expect(
          (await fetchAgentInfo(server.url)).tools.static.map((tool) => tool.name),
        ).not.toContain("get_weather");
        expect(hasKnownDevServerFailure(output())).toBe(false);
      },
      DEV_SERVER_SCENARIO_TIMEOUT_MS,
    );

    it.each(["tool", "workflow"] as const)(
      "makes a newly added %s available to the next turn and allows session retirement",
      async (kind) => {
        const firstResult = await sendDevelopmentMessage({
          message: "Hello.",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        const firstSessionId = firstResult.session.sessionId;
        expect(firstSessionId).toBeDefined();

        await writeFile(
          join(appRoot, "agent", "tools", `get_added_${kind}.ts`),
          kind === "tool"
            ? createGenerationMarkerToolSource("added-tool", false)
            : [
                'import { defineWorkflowTool } from "eve/tools";',
                'import { z } from "zod";',
                "export default defineWorkflowTool({",
                '  description: "Return the added workflow marker.",',
                "  inputSchema: z.object({ city: z.string().optional() }),",
                "  async execute() {",
                '    "use workflow";',
                '    return { marker: "added-workflow" };',
                "  },",
                "});",
              ].join("\n"),
        );
        await forceDevelopmentRebuild(server.url);

        const secondResult = await sendDevelopmentMessage({
          message: `Use get_added_${kind}.`,
          session: firstResult.session,
          serverUrl: server.url,
        });

        expect(secondResult.sessionId).toBe(firstSessionId);
        expect(readCompletedMessages(secondResult.events)).toContain(`added-${kind}`);
        const ended = await fetch(new URL(`/eve/v1/session/${firstSessionId}/end`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Start a new conversation after rebuilding" }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(ended.status, await ended.text()).toBe(202);
      },
      DEV_SERVER_SCENARIO_TIMEOUT_MS,
    );
  });
});
