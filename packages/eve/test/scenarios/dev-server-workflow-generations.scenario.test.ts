import { readFile, writeFile } from "node:fs/promises";
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
        '    const restartPath = join(process.cwd(), ".restart-generation-test");',
        '    writeFileSync(startedPath, "ready");',
        "    if (existsSync(restartPath)) {",
        `      writeFileSync(join(process.cwd(), ".recovered-turn-started"), JSON.stringify({ instrumentation: String(globalThis.__EVE_INSTRUMENTATION_MARKER__ ?? "missing"), marker: ${JSON.stringify(marker)} }));`,
        "    } else {",
        "      await waitForPath(crashPath);",
        "      if (!existsSync(crashedPath)) {",
        '        writeFileSync(crashedPath, "crashed");',
        "        process.exit(1);",
        "      }",
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
          join(app.appRoot, "agent", "instrumentation.ts"),
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
        // Deliberate contract change from the worker-pinned architecture: the
        // retried turn keeps its generation's authored modules but resumes in
        // the replaced worker, so it observes the current instrumentation.
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

  it(
    "makes a newly added tool available to the next turn in a continued session",
    async () => {
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
          createGenerationMarkerToolSource("added-tool", false),
        );
        await forceDevelopmentRebuild(server.url);

        const secondResult = await sendDevelopmentMessage({
          message: "Use get_added_marker.",
          session: firstResult.session,
          serverUrl: server.url,
        });

        expect(secondResult.sessionId).toBe(firstSessionId);
        expect(readCompletedMessages(secondResult.events)).toContain("added-tool");
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "recovers a nonterminal child Workflow on its selected generation after restart",
    async () => {
      const app = await scenarioApp(WORKFLOW_GENERATION_DESCRIPTOR);
      let server = await startEveDev(app.appRoot, {
        env: { WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1" },
      });
      const turnStartedPath = join(app.appRoot, ".turn-started");
      const restartPath = join(app.appRoot, ".restart-generation-test");
      const recoveredPath = join(app.appRoot, ".recovered-turn-started");

      try {
        await writeFile(
          join(app.appRoot, "agent", "tools", "get_marker.ts"),
          createGenerationMarkerToolSource("generation-one-runtime", true),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");

        const interruptedTurn = sendDevelopmentMessage({
          message: "Use get_marker.",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        }).catch(() => undefined);
        await waitForPath(turnStartedPath);

        await writeFile(
          join(app.appRoot, "agent", "tools", "get_marker.ts"),
          createGenerationMarkerToolSource("generation-two", false),
        );
        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createInstrumentationSource("two"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("two");

        await server.crash();
        await withinDeadline(interruptedTurn, "Interrupted client stream did not settle.");
        await writeFile(restartPath, "restart");
        server = await startEveDev(app.appRoot, {
          env: { WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1" },
        });
        await waitForPath(recoveredPath);
        await expect(
          readFile(recoveredPath, "utf8").then((source) => JSON.parse(source) as unknown),
        ).resolves.toEqual({
          // The recovered delivery executes in the restarted worker (current
          // instrumentation) with its recorded generation's modules.
          instrumentation: "two",
          marker: "generation-one-runtime",
        });
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
