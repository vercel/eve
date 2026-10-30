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
import { hasKnownDevServerFailure, isBunAvailable, startEveDev } from "./dev-server-harness.js";

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

describe("eve dev server under Bun", () => {
  // CI installs Bun, so a missing binary there fails instead of skipping.
  it.runIf(isBunAvailable() || process.env.CI !== undefined)(
    "serves HTTP and WebSocket routes from a Bun dev worker",
    async () => {
      const app = await scenarioApp(BUN_WEBSOCKET_DESCRIPTOR);
      const server = await startEveDev(app.appRoot, { defaultExtensions: false, runtime: "bun" });
      const diagnostics = `stdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`;

      try {
        const health = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        expect(health.status, diagnostics).toBe(200);

        const socketUrl = new URL("/echo", server.url);
        socketUrl.protocol = "ws:";
        const socket = new WebSocket(socketUrl);
        const reply = new Promise<string>((resolve, reject) => {
          socket.addEventListener("open", () => socket.send("hello"), { once: true });
          socket.addEventListener("message", (event) => resolve(String(event.data)), {
            once: true,
          });
          socket.addEventListener("error", () => reject(new Error(diagnostics)), { once: true });
        });
        try {
          // The route reports its own runtime, proving the worker is not Node.
          await expect(reply).resolves.toBe("object:hello");
        } finally {
          socket.close();
        }
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
