import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
  createInstrumentationSource,
} from "./dev-server-descriptors.js";
import {
  fetchText,
  forceDevelopmentRebuild,
  startEveDev,
  waitForPath,
  withinDeadline,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const WORKFLOW_GENERATION_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TRANSACTIONAL_REBUILD_DESCRIPTOR,
  files: {
    ...Object.fromEntries(
      Object.entries(TRANSACTIONAL_REBUILD_DESCRIPTOR.files).filter(
        ([path]) => path !== "agent/tools/get_weather.ts" && !path.startsWith("agent/skills/"),
      ),
    ),
    "agent/tools/get_marker.ts": createGenerationMarkerToolSource("generation-one", true),
  },
};

function createGenerationMarkerToolSource(marker: string, crashOnce: boolean): string {
  const lifecycle = crashOnce
    ? [
        'import { existsSync, watch, writeFileSync } from "node:fs";',
        'import { basename, join } from "node:path";',
        "",
        "async function waitForPath(path: string) {",
        "  if (existsSync(path)) return;",
        "  await new Promise<void>((resolve) => {",
        "    const watcher = watch(process.cwd(), (_event, filename) => {",
        "      if (filename !== basename(path)) return;",
        "      watcher.close();",
        "      resolve();",
        "    });",
        "    if (existsSync(path)) {",
        "      watcher.close();",
        "      resolve();",
        "    }",
        "  });",
        "}",
        "",
      ]
    : [];
  const execute = crashOnce
    ? [
        '    const startedPath = join(process.cwd(), ".turn-started");',
        '    const crashPath = join(process.cwd(), ".crash-turn-worker");',
        '    const crashedPath = join(process.cwd(), ".turn-worker-crashed");',
        '    writeFileSync(startedPath, "ready");',
        "    await waitForPath(crashPath);",
        "    if (!existsSync(crashedPath)) {",
        '      writeFileSync(crashedPath, "crashed");',
        "      process.exit(1);",
        "    }",
      ]
    : [];

  return [
    ...lifecycle,
    'import { defineTool } from "eve/tools";',
    'import { z } from "zod";',
    "",
    "export default defineTool({",
    '  description: "Return the selected development generation marker.",',
    "  inputSchema: z.object({ city: z.string().optional() }),",
    "  async execute() {",
    ...execute,
    `    return { instrumentation: "instrumentation-" + String(globalThis.__EVE_INSTRUMENTATION_MARKER__ ?? "missing"), marker: ${JSON.stringify(marker)} };`,
    "  },",
    "});",
    "",
  ].join("\n");
}

describe("eve dev server workflow generations", () => {
  it(
    "retries an active child Workflow on its selected generation after promotion",
    async () => {
      const app = await scenarioApp(WORKFLOW_GENERATION_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const turnStartedPath = join(app.appRoot, ".turn-started");
      const crashWorkerPath = join(app.appRoot, ".crash-turn-worker");

      try {
        const firstTurn = sendDevelopmentMessage({
          message: "Use get_marker.",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        await waitForPath(turnStartedPath);

        await writeFile(
          join(app.appRoot, "agent", "tools", "get_marker.ts"),
          createGenerationMarkerToolSource("generation-two", false),
        );
        await writeFile(
          join(app.appRoot, "agent", "instrumentation", "reload.ts"),
          createInstrumentationSource("two"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("two");

        await writeFile(crashWorkerPath, "crash");
        const firstResult = await withinDeadline(
          firstTurn,
          `Timed out waiting for the selected-generation retry.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );
        expect(readCompletedMessages(firstResult.events)).toContain("generation-one");
        // Providers are installed once by the active host, while durable tool
        // code can retry from the generation that originally selected it.
        expect(readCompletedMessages(firstResult.events)).toContain("instrumentation-two");

        const secondResult = await sendDevelopmentMessage({
          message: "Use get_marker.",
          session: firstResult.session,
          serverUrl: server.url,
        });
        expect(readCompletedMessages(secondResult.events)).toContain("generation-two");
        expect(readCompletedMessages(secondResult.events)).toContain("instrumentation-two");
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it.each(["tool", "workflow"] as const)(
    "makes a newly added %s available to the next turn and allows session reset",
    async (kind) => {
      const app = await scenarioApp(WORKFLOW_GENERATION_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const firstResult = await sendDevelopmentMessage({
          message: "Hello.",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        const firstSessionId = firstResult.session.sessionId;
        expect(firstSessionId).toBeDefined();

        await writeFile(
          join(app.appRoot, "agent", "tools", "get_added_marker.ts"),
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
                '    return { marker: "added-tool" };',
                "  },",
                "});",
              ].join("\n"),
        );
        await forceDevelopmentRebuild(server.url);

        const secondResult = await sendDevelopmentMessage({
          message: "Use get_added_marker.",
          session: firstResult.session,
          serverUrl: server.url,
        });

        expect(secondResult.sessionId).toBe(firstSessionId);
        expect(readCompletedMessages(secondResult.events)).toContain("added-tool");
        const reset = await fetch(new URL(`/eve/v1/session/${firstSessionId}/reset`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Start a new conversation after rebuilding" }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(reset.status, await reset.text()).toBe(200);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});

function readCompletedMessages(
  events: readonly { readonly data?: unknown; readonly type: string }[],
): string {
  return events
    .flatMap((event) => {
      if (event.type !== "message.completed" || !isRecord(event.data)) {
        return [];
      }
      return typeof event.data.message === "string" ? [event.data.message] : [];
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
