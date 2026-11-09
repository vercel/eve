import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createViteEveServiceDescriptor } from "../../src/internal/testing/scenario-apps/vite-eve-service.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import {
  fetchStatus,
  fetchText,
  findFreePort,
  stopChildProcess,
  waitForCondition,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

describe("framework-vite dev", () => {
  it("proxies eve routes to EVE_BASE_URL", async () => {
    const app = await scenarioApp(createViteEveServiceDescriptor());
    // Stands in for the eve server, so the plugin does not spawn `eve dev`.
    const eveServer = createServer((request, response) => {
      response.end(`eve ${request.method} ${request.url}`);
    });
    await new Promise<void>((resolve) => eveServer.listen(0, "127.0.0.1", resolve));
    const eveAddress = eveServer.address();
    if (eveAddress === null || typeof eveAddress === "string") {
      throw new Error("Expected a TCP address for the eve stand-in.");
    }
    const port = await findFreePort();
    const origin = `http://127.0.0.1:${port}`;

    let output = "";
    const child = spawn(
      process.execPath,
      [
        join(app.appRoot, "node_modules", "vite", "bin", "vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: app.appRoot,
        env: { ...process.env, EVE_BASE_URL: `http://127.0.0.1:${eveAddress.port}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    try {
      await waitForCondition(
        async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(
              `vite exited before serving the page (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).\n${output}`,
            );
          }
          return (await fetchStatus(`${origin}/`)) === 200;
        },
        () => `Timed out waiting for vite to serve the page.\n${output}`,
        180_000,
      );

      await expect(fetchText(origin, "/eve/v1/health")).resolves.toBe("eve GET /eve/v1/health");
    } finally {
      await stopChildProcess(child);
      await new Promise<void>((resolve) => eveServer.close(() => resolve()));
    }
  }, 300_000);
});
