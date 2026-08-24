import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { build, createNitro, prepare } from "nitro/builder";
import { describe, expect, it } from "vitest";

import { createProductionNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { registerChannelVirtualHandlers } from "#internal/nitro/host/channel-routes.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("built Nitro channel routes", () => {
  it("executes explicit OPTIONS handlers while generated preflight remains a 204", async () => {
    const root = await createScratchDirectory("eve-channel-routes-nitro-");
    const outputDir = join(root, ".output");
    const nitro = await createNitro({
      output: { dir: outputDir },
      preset: "node-server",
      rootDir: root,
    });

    registerChannelVirtualHandlers(nitro, {
      artifactsConfig: createProductionNitroArtifactsConfig(),
      routes: [
        { cors: {}, kind: "channel", method: "OPTIONS", path: "/explicit" },
        { cors: {}, kind: "channel-preflight", method: "OPTIONS", path: "/generated" },
        { kind: "channel", method: "GET", path: "/items/:itemId" },
      ],
    });

    const explicitVirtualId = "#nitro/virtual/eve-channel/OPTIONS /explicit";
    const explicitSource = nitro.options.virtual[explicitVirtualId];
    if (typeof explicitSource !== "string") {
      throw new Error("Expected the explicit OPTIONS virtual handler to be static source.");
    }
    nitro.options.virtual[explicitVirtualId] = explicitSource.replace(
      /^import \{ dispatchChannelRequest \} from .+;$/m,
      "const dispatchChannelRequest = (_event, routeKey) => new Response(routeKey, { status: 207 });",
    );
    const parameterVirtualId = "#nitro/virtual/eve-channel/GET /items/:itemId";
    const parameterSource = nitro.options.virtual[parameterVirtualId];
    if (typeof parameterSource !== "string") {
      throw new Error("Expected the parameterized virtual handler to be static source.");
    }
    nitro.options.virtual[parameterVirtualId] = parameterSource.replace(
      /^import \{ dispatchChannelRequest \} from .+;$/m,
      "const dispatchChannelRequest = (_event, routeKey) => new Response(routeKey);",
    );

    await prepare(nitro);
    await build(nitro);
    await nitro.close();

    const port = await reservePort();
    const child = spawn(process.execPath, [join(outputDir, "server", "index.mjs")], {
      env: {
        ...process.env,
        NITRO_HOST: "127.0.0.1",
        NITRO_PORT: String(port),
      },
      stdio: "pipe",
    });

    try {
      const explicit = await fetchWhenReady(`http://127.0.0.1:${port}/explicit`, {
        headers: {
          "access-control-request-method": "POST",
          origin: "https://example.com",
        },
        method: "OPTIONS",
      });
      expect(explicit.status).toBe(207);
      await expect(explicit.text()).resolves.toBe("OPTIONS /explicit");
      expect(explicit.headers.get("access-control-allow-origin")).toBe("*");

      const generated = await fetch(`http://127.0.0.1:${port}/generated`, {
        headers: {
          "access-control-request-method": "POST",
          origin: "https://example.com",
        },
        method: "OPTIONS",
      });
      expect(generated.status).toBe(204);

      const parameterized = await fetch(`http://127.0.0.1:${port}/items/123/`);
      expect(parameterized.status).toBe(200);
      await expect(parameterized.text()).resolves.toBe("GET /items/:itemId");
    } finally {
      await stopChild(child);
    }
  });
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function fetchWhenReady(url: string, init: RequestInit): Promise<Response> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw lastError;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}
