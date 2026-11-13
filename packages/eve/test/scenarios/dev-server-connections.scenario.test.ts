import { Agent } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "../../src/internal/testing/scenario-app.js";
import {
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
  type RunningEveDev,
  startEveDev,
  waitForCondition,
  waitForPath,
  withinDeadline,
} from "#internal/testing/dev-server-harness.js";

// One app serves every test: the transactional channel's worker id and
// instrumentation marker, a held stream, a WebSocket, and an env marker.
const CONNECTIONS_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TRANSACTIONAL_REBUILD_DESCRIPTOR,
  files: {
    ...TRANSACTIONAL_REBUILD_DESCRIPTOR.files,
    "agent/channels/env-generation.ts": [
      'import { defineChannel, GET } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [GET("/env-generation", () => new Response(process.env.EVE_WEBSOCKET_RELOAD ?? "initial"))],',
      "});",
      "",
    ].join("\n"),
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
    "agent/channels/held-stream.ts": [
      'import { existsSync, watch } from "node:fs";',
      'import { join } from "node:path";',
      'import { defineChannel, GET } from "eve/channels";',
      "",
      "export default defineChannel({",
      "  routes: [",
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
    'import { defineInstrumentation } from "eve/instrumentation";',
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
    "export default defineInstrumentation({});",
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
      socket.removeEventListener(eventName, onEvent);
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
    socket.addEventListener(eventName, onEvent, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

// Each test only checks changes it makes, so the tests share one server.
describe("eve dev server live connections", () => {
  let appRoot: string;
  let cleanupApp: (() => Promise<void>) | undefined;
  let server: RunningEveDev;

  beforeAll(async () => {
    const app = await materializeScenarioApp(CONNECTIONS_DESCRIPTOR);
    appRoot = app.appRoot;
    try {
      server = await startEveDev(appRoot);
    } catch (error) {
      await app.cleanup();
      throw error;
    }
    cleanupApp = app.cleanup;
  }, DEV_SERVER_SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await cleanupApp?.();
  }, DEV_SERVER_SCENARIO_TIMEOUT_MS);

  /** Server output written from now on. */
  function outputFromNow(): () => string {
    const stdoutStart = server.stdout().length;
    const stderrStart = server.stderr().length;
    return () => `${server.stdout().slice(stdoutStart)}\n${server.stderr().slice(stderrStart)}`;
  }

  it(
    "keeps streams and parent control routes alive while a structural candidate is prepared",
    async () => {
      const output = outputFromNow();
      const candidateStartedPath = join(appRoot, ".candidate-started");
      const candidateReadyPath = join(appRoot, ".candidate-ready");
      const streamReleasePath = join(appRoot, ".stream-release");

      const initialRevision = await readDevelopmentRevision(server.url);
      const initialMarker = await fetchText(server.url, "/instrumentation-marker");
      expect(initialMarker).not.toBe("two");
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
        join(appRoot, "agent", "instrumentation", "reload.ts"),
        createBlockedInstrumentationSource(),
      );
      const rebuild = forceDevelopmentRebuild(server.url);
      await waitForPath(candidateStartedPath);

      await expect(readDevelopmentRevision(server.url)).resolves.toBe(initialRevision);
      await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe(initialMarker);

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
      expect(hasKnownDevServerFailure(output())).toBe(false);
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "serves a kept-alive connection across a structural worker replacement",
    async () => {
      const output = outputFromNow();
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });

      try {
        const first = await requestWithAgent(new URL("/worker-id", server.url).href, agent);
        expect(first.localPort).toBeDefined();

        await writeFile(
          join(appRoot, "agent", "instrumentation", "reload.ts"),
          createInstrumentationSource("keep-alive-two"),
        );
        await forceDevelopmentRebuild(server.url, agent);
        await waitForCondition(
          async () => (await fetchText(server.url, "/instrumentation-marker")) === "keep-alive-two",
          () => `Timed out waiting for the structural replacement.\n\n${output()}`,
        );

        const second = await requestWithAgent(new URL("/worker-id", server.url).href, agent);
        expect(second.localPort).toBe(first.localPort);
        expect(second.body).not.toBe(first.body);
        expect(hasKnownDevServerFailure(output())).toBe(false);
      } finally {
        agent.destroy();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps an admitted websocket on its worker while a ready replacement is promoted",
    async () => {
      const output = outputFromNow();
      const socketUrl = new URL("/socket", server.url);
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);

      try {
        await waitForWebSocketOpen(socket);
        const firstMessage = waitForWebSocketMessage(socket);
        socket.send("before");
        await expect(firstMessage).resolves.toBe("hidden:127.0.0.1:before");

        await writeFile(join(appRoot, ".env.local"), "EVE_WEBSOCKET_RELOAD=1\n");
        await waitForCondition(
          async () => (await fetchText(server.url, "/env-generation")) === "1",
          () => `Timed out waiting for websocket worker replacement.\n\n${output()}`,
        );

        const nextMessage = waitForWebSocketMessage(socket);
        socket.send("after");
        await expect(nextMessage).resolves.toBe("hidden:127.0.0.1:after");
      } finally {
        if (socket.readyState === WebSocket.OPEN) {
          const closed = waitForWebSocketClose(socket);
          socket.close();
          await closed;
        }
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
