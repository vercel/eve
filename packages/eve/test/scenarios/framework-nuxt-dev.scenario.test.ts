import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNuxtEveServiceDescriptor } from "../../src/internal/testing/scenario-apps/nuxt-eve-service.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { stopChildProcess, waitForCondition } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const NUXT_EVE_SERVICE_DESCRIPTOR = createNuxtEveServiceDescriptor({
  installDependencies: true,
});

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address for the free-port probe.");
  }
  return address.port;
}

async function fetchStatus(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url);
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}

describe("framework-nuxt dev", () => {
  it("serves the auto-imported useEveAgent from Vite's pre-bundled dependencies", async () => {
    const app = await scenarioApp(NUXT_EVE_SERVICE_DESCRIPTOR);
    const port = await findFreePort();
    const origin = `http://127.0.0.1:${port}`;

    let output = "";
    const child = spawn(
      process.execPath,
      [
        join(app.appRoot, "node_modules", "nuxt", "bin", "nuxt.mjs"),
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: app.appRoot,
        // Proxy to an unused origin so the module does not spawn an eve dev
        // server; serving the page does not reach eve.
        env: { ...process.env, EVE_BASE_URL: "http://127.0.0.1:9" },
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
              `nuxt dev exited before serving the page (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).\n${output}`,
            );
          }
          return (await fetchStatus(`${origin}/`)) === 200;
        },
        () => `Timed out waiting for nuxt dev to serve the page.\n${output}`,
        180_000,
      );

      // Unbundled, `eve/vue` reaches the browser with CommonJS dependencies
      // whose named imports fail, and the app never hydrates.
      const appModule = await (await fetch(`${origin}/_nuxt/app.vue`)).text();
      const importSource = /import \{ useEveAgent \} from "([^"]+)"/.exec(appModule)?.[1];

      expect(importSource).toContain("/.cache/vite/client/deps/");
    } finally {
      await stopChildProcess(child);
    }
  }, 300_000);
});
