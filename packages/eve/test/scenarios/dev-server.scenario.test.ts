import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, watch as watchFileSystem } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
} from "../../src/protocol/routes.js";
import type { AgentInfoResponse } from "../../src/internal/nitro/routes/agent-info/build-agent-info-response.js";
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
      '      const transportHeader = peer.request.headers.has("x-eve-dev-worker-metadata") ? "exposed" : "hidden";',
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

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function hasUnsupportedWindowsEsmImport(text: string): boolean {
  return (
    text.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    text.includes("Received protocol 'g:'") ||
    text.includes('Received protocol "g:"')
  );
}

function hasKnownDevServerFailure(text: string): boolean {
  return (
    hasUnsupportedWindowsEsmImport(text) ||
    text.includes("UNRESOLVED_IMPORT") ||
    text.includes("ECONNRESET") ||
    text.includes("socket hang up") ||
    (text.includes("ERR_MODULE_NOT_FOUND") && text.includes("authored-module-map-loader"))
  );
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));

  return match?.[1];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string,
  timeoutMs: number = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(failureMessage);
    }
    await wait(100);
  }
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev to print its server URL.",
            `stdout:\n${input.getOutput().stdout}`,
            `stderr:\n${input.getOutput().stderr}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout.off("data", handleOutput);
      input.child.stderr.off("data", handleOutput);
      input.child.off("error", settleReject);
      input.child.off("exit", handleExit);
    };

    const settleResolve = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const output = input.getOutput();
      const combinedOutput = `${output.stdout}\n${output.stderr}`;

      if (hasKnownDevServerFailure(combinedOutput)) {
        settleReject(
          new Error(
            [
              "eve dev emitted a known reload or generated-bundle failure.",
              `stdout:\n${output.stdout}`,
              `stderr:\n${output.stderr}`,
            ].join("\n\n"),
          ),
        );
        return;
      }

      const url = parseServerUrl(output.stdout);

      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      const output = input.getOutput();

      settleReject(
        new Error(
          [
            `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${output.stdout}`,
            `stderr:\n${output.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    input.child.stdout.on("data", handleOutput);
    input.child.stderr.on("data", handleOutput);
    input.child.once("error", settleReject);
    input.child.once("exit", handleExit);
    handleOutput();
  });
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

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        // Activate the deterministic mock-model adapter in the spawned dev
        // server so the streamed turn completes without model credentials.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const url = await waitForServerUrl({
    child,
    getOutput: () => ({
      stderr,
      stdout,
    }),
  });
  await waitForPath(join(appRoot, ".eve", "dev-server-state.v1.json"));

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
    url,
  };
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
});

async function fetchText(serverUrl: string, path: string): Promise<string> {
  const response = await fetch(new URL(path, serverUrl));
  if (!response.ok) {
    throw new Error(`Expected ${path} to succeed, received ${String(response.status)}.`);
  }
  return await response.text();
}

async function fetchAgentInfo(serverUrl: string): Promise<AgentInfoResponse> {
  const response = await fetch(new URL(EVE_INFO_ROUTE_PATH, serverUrl));
  if (!response.ok) {
    throw new Error(`Expected agent info to succeed, received ${String(response.status)}.`);
  }
  return (await response.json()) as AgentInfoResponse;
}

async function forceDevelopmentRebuild(serverUrl: string): Promise<void> {
  const rebuildUrl = new URL(EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH, serverUrl);
  rebuildUrl.searchParams.set("force", "1");
  const response = await fetch(rebuildUrl);
  if (!response.ok) {
    throw new Error(`Development rebuild failed with status ${String(response.status)}.`);
  }
}

async function readDevelopmentRevision(serverUrl: string): Promise<string> {
  const response = await fetch(new URL(EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH, serverUrl));
  if (!response.ok) {
    throw new Error(`Development runtime state failed with status ${String(response.status)}.`);
  }
  const body = (await response.json()) as { readonly revision?: unknown };
  if (typeof body.revision !== "string") {
    throw new Error("Development runtime state did not include a revision.");
  }
  return body.revision;
}

async function waitForPath(path: string): Promise<void> {
  if (existsSync(path)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const watcher = watchFileSystem(dirname(path), () => {
      if (existsSync(path)) {
        settle(resolve);
      }
    });
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`Timed out waiting for ${path}.`)));
    }, 60_000);
    function settle(complete: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      complete();
    }
    if (existsSync(path)) {
      settle(resolve);
    }
  });
}

async function withinDeadline<T>(operation: Promise<T>, failureMessage: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(failureMessage)), 60_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
