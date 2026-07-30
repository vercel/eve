import { Agent } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import {
  DEV_SERVER_AGENT_DESCRIPTOR,
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
  createInstrumentationSource,
} from "./dev-server-descriptors.js";
import {
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

const scenarioApp = useScenarioApp();

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

describe("eve dev server live connections", () => {
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
});
