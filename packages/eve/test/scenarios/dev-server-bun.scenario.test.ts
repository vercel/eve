import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import {
  DEV_SERVER_AGENT_DESCRIPTOR,
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
} from "./dev-server-descriptors.js";
import {
  hasKnownDevServerFailure,
  resolveBunExecutable,
  startEveDev,
  waitForCondition,
  waitForWebSocketMessage,
  waitForWebSocketOpen,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const BUN_WEBSOCKET_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  name: "dev-server-bun",
  files: {
    ...DEV_SERVER_AGENT_DESCRIPTOR.files,
    "agent/channels/echo.ts": [
      'import { defineChannel, WS } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [WS("/echo", () => ({',
      "    message(peer, message) {",
      "      peer.send(`${typeof Bun}:${message.text()}`);",
      "    },",
      "  }))],",
      "});",
      "",
    ].join("\n"),
  },
};

describe("eve dev server launched by Bun", () => {
  // CI installs Bun, so a missing binary there fails instead of skipping.
  it.runIf(resolveBunExecutable() !== undefined || process.env.CI !== undefined)(
    "hands the Node bin off to Bun, serves HTTP and WebSocket routes, and stops on SIGTERM",
    async () => {
      const app = await scenarioApp(BUN_WEBSOCKET_DESCRIPTOR);
      const server = await startEveDev(app.appRoot, { defaultExtensions: false, runtime: "bun" });
      const diagnostics = () => `stdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`;

      try {
        const health = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        expect(health.status, diagnostics()).toBe(200);

        const socketUrl = new URL("/echo", server.url);
        socketUrl.protocol = "ws:";
        const socket = new WebSocket(socketUrl);
        try {
          await waitForWebSocketOpen(socket);
          const reply = waitForWebSocketMessage(socket);
          socket.send("hello");
          // The route reports its own runtime, proving the worker is not Node.
          expect(await reply, diagnostics()).toBe("object:hello");
        } finally {
          socket.close();
        }
        expect(hasKnownDevServerFailure(diagnostics()), diagnostics()).toBe(false);

        // Supervisors signal only the PID they started; it must reach Bun.
        const exit = await server.signalAndAwaitExit("SIGTERM", 20_000);
        expect(exit.forcedKill, diagnostics()).toBe(false);
        await waitForCondition(
          async () =>
            await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url)).then(
              () => false,
              () => true,
            ),
          () => `The dev server kept serving after SIGTERM.\n\n${diagnostics()}`,
        );
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
