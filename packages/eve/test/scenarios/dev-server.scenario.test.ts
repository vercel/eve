import { Agent } from "node:http";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import {
  readDevelopmentRuntimeArtifactsSnapshotRoot,
  resolveDevelopmentRuntimeArtifactsPointerPath,
} from "../../src/internal/nitro/dev-runtime-artifacts.js";
import { STRUCTURAL_RELOAD_LOG_LINE } from "../../src/internal/nitro/host/dev-watcher-log.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  fetchAgentInfo,
  fetchText,
  forceDevelopmentRebuild,
  hasKnownDevServerFailure,
  readDevelopmentRevision,
  requestWithAgent,
  startEveDev,
  waitForCondition,
  waitForPath,
  withinDeadline,
} from "./dev-server-harness.js";

// Keep the dev TUI's glyph set deterministic across CI hosts so the
// screen assertions below remain stable.
process.env.EVE_TUI_UNICODE = "1";

const scenarioApp = useScenarioApp();
const DEV_SERVER_SCENARIO_TIMEOUT_MS = 360_000;
const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: {
    ...Object.fromEntries(
      Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
        ([path]) => !path.startsWith("agent/channels/"),
      ),
    ),
    "agent/channels/dev-generation.ts": [
      'import { defineChannel, GET } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [GET("/dev-generation", () => new Response(process.env.EVE_SCENARIO_RELOAD ?? process.env.EVE_WEBSOCKET_RELOAD ?? "initial"))],',
      "});",
      "",
    ].join("\n"),
  },
};
const WEBSOCKET_DEV_SERVER_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  files: {
    ...DEV_SERVER_AGENT_DESCRIPTOR.files,
    "agent/channels/socket.ts": [
      'import { defineChannel, WS } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [WS("/socket", () => ({',
      "    message(peer, message) {",
      '      const transportHeader = peer.request.headers.has("x-eve-dev-workflow-delivery") ? "exposed" : "hidden";',
      '      peer.send(`${transportHeader}:${peer.remoteAddress ?? "missing"}:${message.text()}`);',
      "    },",
      "  }))],",
      "});",
      "",
    ].join("\n"),
  },
};
const TRANSACTIONAL_REBUILD_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  files: {
    ...DEV_SERVER_AGENT_DESCRIPTOR.files,
    "agent/channels/dev-generation.ts": createOverlappingChannelSource(),
    "agent/instrumentation.ts": createInstrumentationSource("one"),
  },
};
const SCHEDULE_DISPATCH_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: {
    ...WEATHER_AGENT_DESCRIPTOR.files,
    "agent/schedules/heartbeat.md": [
      "---",
      'cron: "0 0 * * 0"',
      "---",
      "",
      "Report the weather in Lisbon.",
      "",
    ].join("\n"),
  },
  name: "weather-agent-schedules",
};
const NPM_LAYOUT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  name: "weather-agent-npm",
  packageManager: "npm",
};
const STREAM_PROMOTION_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TRANSACTIONAL_REBUILD_DESCRIPTOR,
  files: {
    ...TRANSACTIONAL_REBUILD_DESCRIPTOR.files,
    "agent/channels/dev-generation.ts": [
      'import { existsSync, watch } from "node:fs";',
      'import { join } from "node:path";',
      'import { defineChannel, GET } from "eve/channels";',
      "",
      "export default defineChannel({",
      "  routes: [",
      '    GET("/instrumentation-marker", () => new Response(String(globalThis.__EVE_INSTRUMENTATION_MARKER__ ?? "missing"))),',
      '    GET("/held-stream", () => {',
      '      const releasePath = join(process.cwd(), ".stream-release");',
      "      let releaseWatcher: ReturnType<typeof watch> | undefined;",
      "      let finished = false;",
      "      return new Response(new ReadableStream({",
      "        start(controller) {",
      '          controller.enqueue(new TextEncoder().encode("first\\n"));',
      "          const finish = () => {",
      "            if (finished) return;",
      "            finished = true;",
      "            releaseWatcher?.close();",
      '            controller.enqueue(new TextEncoder().encode("second\\n"));',
      "            controller.close();",
      "          };",
      "          if (existsSync(releasePath)) {",
      "            finish();",
      "            return;",
      "          }",
      "          releaseWatcher = watch(process.cwd(), (_event, filename) => {",
      '            if (filename === ".stream-release") finish();',
      "          });",
      "          if (existsSync(releasePath)) finish();",
      "        },",
      "        cancel() { releaseWatcher?.close(); },",
      "      }));",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
  },
};
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

function createInstrumentationSource(marker: string): string {
  return [
    'import { randomUUID } from "node:crypto";',
    "",
    "declare global {",
    "  var __EVE_INSTRUMENTATION_MARKER__: string | undefined;",
    "  var __EVE_WORKER_ID__: string | undefined;",
    "}",
    "",
    `globalThis.__EVE_INSTRUMENTATION_MARKER__ = ${JSON.stringify(marker)};`,
    "globalThis.__EVE_WORKER_ID__ = randomUUID();",
    "export default {};",
    "",
  ].join("\n");
}

function createCandidateChannelSource(): string {
  return createTransactionalChannelSource([
    '    GET("/candidate-only", () => new Response("candidate")),',
  ]);
}

function createOverlappingChannelSource(): string {
  return createTransactionalChannelSource([
    '    GET("/overlap/:slug", (_request, context) => new Response(`parameter:${context.params.slug}`)),',
    '    GET("/overlap/static", () => new Response("static")),',
  ]);
}

function createTransactionalChannelSource(routeLines: readonly string[]): string {
  return [
    'import { defineChannel, GET } from "eve/channels";',
    "",
    "export default defineChannel({",
    "  routes: [",
    '    GET("/instrumentation-marker", () => new Response(String(globalThis.__EVE_INSTRUMENTATION_MARKER__ ?? "missing"))),',
    '    GET("/worker-id", () => new Response(String(globalThis.__EVE_WORKER_ID__ ?? "missing"))),',
    ...routeLines,
    "  ],",
    "});",
    "",
  ].join("\n");
}

function createBlockedInstrumentationSource(): string {
  return [
    'import { existsSync, watch, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "",
    "declare global {",
    "  var __EVE_INSTRUMENTATION_MARKER__: string | undefined;",
    "}",
    "",
    'const startedPath = join(process.cwd(), ".candidate-started");',
    'const readyPath = join(process.cwd(), ".candidate-ready");',
    'writeFileSync(startedPath, "ready");',
    "await new Promise<void>((resolve) => {",
    "  if (existsSync(readyPath)) {",
    "    resolve();",
    "    return;",
    "  }",
    "  const readyWatcher = watch(process.cwd(), (_event, filename) => {",
    '    if (filename !== ".candidate-ready") return;',
    "    readyWatcher.close();",
    "    resolve();",
    "  });",
    "  if (existsSync(readyPath)) {",
    "    readyWatcher.close();",
    "    resolve();",
    "  }",
    "});",
    'globalThis.__EVE_INSTRUMENTATION_MARKER__ = "two";',
    "export default {};",
    "",
  ].join("\n");
}

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  await waitForWebSocketEvent(socket, "open", () => undefined);
}

async function waitForWebSocketMessage(socket: WebSocket): Promise<string> {
  return await waitForWebSocketEvent(socket, "message", (event) => String(event.data));
}

async function waitForWebSocketClose(socket: WebSocket): Promise<void> {
  await waitForWebSocketEvent(socket, "close", () => undefined);
}

async function waitForWebSocketEvent<T>(
  socket: WebSocket,
  eventName: "close" | "message" | "open",
  select: (event: MessageEvent) => T,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket ${eventName}.`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(deadline);
      socket.removeEventListener(eventName, onEvent as EventListener);
      socket.removeEventListener("error", onError);
    };
    const onEvent = (event: Event) => {
      cleanup();
      resolve(select(event as MessageEvent));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket failed while waiting for ${eventName}.`));
    };
    socket.addEventListener(eventName, onEvent as EventListener, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

describe("eve dev server", () => {
  it(
    "publishes authored tool removals without replacing the active host",
    async () => {
      const app = await scenarioApp(TRANSACTIONAL_REBUILD_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const initialRevision = await readDevelopmentRevision(server.url);
        const initialWorkerId = await fetchText(server.url, "/worker-id");
        expect(
          (await fetchAgentInfo(server.url)).tools.authored.map((tool) => tool.name),
        ).toContain("get_weather");

        await rm(join(app.appRoot, "agent", "tools", "get_weather.ts"));
        await forceDevelopmentRebuild(server.url);

        await expect(readDevelopmentRevision(server.url)).resolves.not.toBe(initialRevision);
        await expect(fetchText(server.url, "/worker-id")).resolves.toBe(initialWorkerId);
        expect(
          (await fetchAgentInfo(server.url)).tools.authored.map((tool) => tool.name),
        ).not.toContain("get_weather");
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "replaces the worker for instrumentation changes and preserves Nitro's selected route",
    async () => {
      const app = await scenarioApp(TRANSACTIONAL_REBUILD_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");
        await expect(fetchText(server.url, "/overlap/static")).resolves.toBe("static");
        const initialWorkerId = await fetchText(server.url, "/worker-id");

        await forceDevelopmentRebuild(server.url);
        await expect(fetchText(server.url, "/worker-id")).resolves.toBe(initialWorkerId);

        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createInstrumentationSource("two"),
        );
        await forceDevelopmentRebuild(server.url);

        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("two");
        await expect(fetchText(server.url, "/worker-id")).resolves.not.toBe(initialWorkerId);
        await expect(fetchText(server.url, "/overlap/static")).resolves.toBe("static");
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps the complete prior generation active when a structural candidate fails",
    async () => {
      const app = await scenarioApp(TRANSACTIONAL_REBUILD_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const initialRevision = await readDevelopmentRevision(server.url);
        await writeFile(
          join(app.appRoot, "agent", "channels", "dev-generation.ts"),
          ['import "./missing-candidate-module.ts";', createCandidateChannelSource()].join("\n"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(readDevelopmentRevision(server.url)).resolves.toBe(initialRevision);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");

        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          'throw new Error("stage 4 rejected candidate");\nexport default {};\n',
        );
        await writeFile(
          join(app.appRoot, "agent", "channels", "dev-generation.ts"),
          createCandidateChannelSource(),
        );
        try {
          await forceDevelopmentRebuild(server.url);
        } catch (error) {
          throw new Error(
            `Rejected candidate rebuild request failed.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
            { cause: error },
          );
        }

        await expect(readDevelopmentRevision(server.url)).resolves.toBe(initialRevision);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");
        const candidateRoute = await fetch(new URL("/candidate-only", server.url));
        expect(candidateRoute.status).toBe(404);

        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createInstrumentationSource("two"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(readDevelopmentRevision(server.url)).resolves.not.toBe(initialRevision);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("two");
        await expect(fetchText(server.url, "/candidate-only")).resolves.toBe("candidate");

        await writeFile(
          join(app.appRoot, "agent", "channels", "dev-generation.ts"),
          createOverlappingChannelSource(),
        );
        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createInstrumentationSource("one"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");
        await expect(fetchText(server.url, "/overlap/static")).resolves.toBe("static");
        const revertedCandidateRoute = await fetch(new URL("/candidate-only", server.url));
        expect(revertedCandidateRoute.status).toBe(404);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps streams and parent control routes alive while a structural candidate is prepared",
    async () => {
      const app = await scenarioApp(STREAM_PROMOTION_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const candidateStartedPath = join(app.appRoot, ".candidate-started");
      const candidateReadyPath = join(app.appRoot, ".candidate-ready");
      const streamReleasePath = join(app.appRoot, ".stream-release");

      try {
        const initialRevision = await readDevelopmentRevision(server.url);
        const streamResponse = await fetch(new URL("/held-stream", server.url));
        if (streamResponse.body === null) {
          throw new Error("Held stream response did not include a body.");
        }
        const reader = streamResponse.body.getReader();
        const firstChunk = await withinDeadline(
          reader.read(),
          "Timed out waiting for the first stream chunk.",
        );
        expect(new TextDecoder().decode(firstChunk.value)).toBe("first\n");

        // The parent-owned control route must answer continuously through
        // candidate preparation and promotion, not merely at spot checks.
        const revisionFailures: string[] = [];
        let stopRevisionPolling = false;
        const revisionPoller = (async () => {
          while (!stopRevisionPolling) {
            try {
              await readDevelopmentRevision(server.url);
            } catch (error) {
              revisionFailures.push(String(error));
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
          }
        })();

        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createBlockedInstrumentationSource(),
        );
        const rebuild = forceDevelopmentRebuild(server.url);
        await waitForPath(candidateStartedPath);

        await expect(readDevelopmentRevision(server.url)).resolves.toBe(initialRevision);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");

        await writeFile(candidateReadyPath, "ready");
        await withinDeadline(rebuild, "Timed out waiting for candidate promotion.");
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("two");

        stopRevisionPolling = true;
        await revisionPoller;
        expect(revisionFailures, revisionFailures.join("\n")).toEqual([]);

        await writeFile(streamReleasePath, "release");
        const secondChunk = await withinDeadline(
          reader.read(),
          "Timed out waiting for the retired worker stream.",
        );
        expect(new TextDecoder().decode(secondChunk.value)).toBe("second\n");
        await expect(reader.read()).resolves.toEqual(expect.objectContaining({ done: true }));
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "serves a kept-alive connection across a structural worker replacement",
    async () => {
      const app = await scenarioApp(TRANSACTIONAL_REBUILD_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });

      try {
        const first = await requestWithAgent(new URL("/worker-id", server.url).href, agent);
        expect(first.localPort).toBeDefined();

        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createInstrumentationSource("keep-alive-two"),
        );
        await forceDevelopmentRebuild(server.url);
        await waitForCondition(
          async () => (await fetchText(server.url, "/instrumentation-marker")) === "keep-alive-two",
          `Timed out waiting for the structural replacement.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );

        const second = await requestWithAgent(new URL("/worker-id", server.url).href, agent);
        expect(second.localPort).toBe(first.localPort);
        expect(second.body).not.toBe(first.body);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        agent.destroy();
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps an admitted websocket on its worker while a ready replacement is promoted",
    async () => {
      const app = await scenarioApp(WEBSOCKET_DEV_SERVER_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const socketUrl = new URL("/socket", server.url);
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);

      try {
        await waitForWebSocketOpen(socket);
        const firstMessage = waitForWebSocketMessage(socket);
        socket.send("before");
        await expect(firstMessage).resolves.toBe("hidden:127.0.0.1:before");

        await writeFile(join(app.appRoot, ".env.local"), "EVE_WEBSOCKET_RELOAD=1\n");
        await waitForCondition(async () => {
          const generation = await fetch(new URL("/dev-generation", server.url));
          return (await generation.text()) === "1";
        }, `Timed out waiting for websocket worker replacement.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);

        const nextMessage = waitForWebSocketMessage(socket);
        socket.send("after");
        await expect(nextMessage).resolves.toBe("hidden:127.0.0.1:after");
      } finally {
        if (socket.readyState === WebSocket.OPEN) {
          const closed = waitForWebSocketClose(socket);
          socket.close();
          await closed;
        }
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "rebuilds after its startup runtime generation is force-pruned and completes a streamed turn",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const responseText = await response.text();

        expect(
          response.status,
          [
            `Expected ${EVE_HEALTH_ROUTE_PATH} to return 200.`,
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(JSON.parse(responseText)).toMatchObject({
          ok: true,
          status: "ready",
        });

        const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(app.appRoot);
        const startupRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
        if (startupRuntimeRoot === undefined) {
          throw new Error("Expected eve dev to publish an initial runtime snapshot.");
        }

        await writeFile(
          join(app.appRoot, "agent", "instructions.md"),
          "Use the weather tool and answer with the current conditions.\n",
        );
        await waitForCondition(() => {
          const currentRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
          return currentRuntimeRoot !== undefined && currentRuntimeRoot !== startupRuntimeRoot;
        }, `Timed out waiting for authored HMR.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);

        const authoredRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
        if (authoredRuntimeRoot === undefined) {
          throw new Error("Expected authored HMR to publish a runtime snapshot.");
        }

        await rm(startupRuntimeRoot, { force: true, recursive: true });
        expect(existsSync(startupRuntimeRoot)).toBe(false);

        await writeFile(join(app.appRoot, ".env.local"), "EVE_SCENARIO_RELOAD=1\n");
        await waitForCondition(
          () => server.stdout().includes(STRUCTURAL_RELOAD_LOG_LINE),
          `Timed out waiting for a structural Nitro reload.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );
        expect(readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath)).toBe(authoredRuntimeRoot);
        await waitForCondition(async () => {
          const generation = await fetch(new URL("/dev-generation", server.url));
          return (await generation.text()) === "1";
        }, `Timed out waiting for a ready replacement worker.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);
        let messageResult: Awaited<ReturnType<typeof sendDevelopmentMessage>>;
        try {
          messageResult = await sendDevelopmentMessage({
            message: "hello world",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
          });
        } catch (error) {
          throw new Error(
            [
              `Expected dev message route to complete without throwing: ${String(error)}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevServerFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

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

  it(
    "dispatches an authored schedule through the dev route on its generation",
    async () => {
      const app = await scenarioApp(SCHEDULE_DISPATCH_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL("/eve/v1/dev/schedules/heartbeat", server.url), {
          method: "POST",
        });
        const body = (await response.json()) as {
          scheduleId?: string;
          sessionIds?: readonly string[];
        };
        expect(
          response.status,
          [
            `Expected the dev schedule dispatch route to succeed: ${JSON.stringify(body)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(body.scheduleId).toBe("heartbeat");
        expect(body.sessionIds).toHaveLength(1);

        const unknown = await fetch(new URL("/eve/v1/dev/schedules/missing", server.url), {
          method: "POST",
        });
        expect(unknown.status).toBe(404);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "serves an npm-installed app with hoisted real-directory dependencies",
    async () => {
      const app = await scenarioApp(NPM_LAYOUT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const messageResult = await sendDevelopmentMessage({
          message: "What's the weather in Lisbon?",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected the npm-installed dev server to complete a streamed turn.",
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
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
