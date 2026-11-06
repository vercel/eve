import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNuxtEveServiceDescriptor } from "../../src/internal/testing/scenario-apps/nuxt-eve-service.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";
import { stopChildProcess, waitForCondition } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const NUXT_EVE_SERVICE_DESCRIPTOR = createNuxtEveServiceDescriptor({
  installDependencies: true,
});

async function readVercelOutputConfig(outputRoot: string): Promise<{
  readonly routes: readonly unknown[];
  readonly services: Record<string, unknown>;
}> {
  const config: unknown = JSON.parse(await readFile(join(outputRoot, "config.json"), "utf8"));

  if (
    typeof config !== "object" ||
    config === null ||
    !("routes" in config) ||
    !Array.isArray(config.routes)
  ) {
    throw new Error("Expected Vercel Build Output config.json to contain a routes array.");
  }

  const services =
    "services" in config && typeof config.services === "object" && config.services !== null
      ? (config.services as Record<string, unknown>)
      : {};

  return { routes: config.routes, services };
}

function isEveServiceRoute(route: unknown): boolean {
  return (
    typeof route === "object" &&
    route !== null &&
    "src" in route &&
    route.src === "^/eve/v1/(.*)$" &&
    "destination" in route
  );
}

function isFilesystemHandle(route: unknown): boolean {
  return (
    typeof route === "object" &&
    route !== null &&
    "handle" in route &&
    route.handle === "filesystem"
  );
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("Expected a TCP port.");
  return address.port;
}

async function assertNuxtHealth(
  deployment: string,
  env: NodeJS.ProcessEnv,
  expectedStatus = 200,
  pendingStartupPidPath?: string,
): Promise<void> {
  const port = await findFreePort();
  let output = "";
  let backendPid: number | undefined;
  const pendingRequest = new AbortController();
  const clustered = env.NITRO_CLUSTER_WORKERS !== undefined;
  const child = spawn(process.execPath, [join(deployment, ".output/server/index.mjs")], {
    cwd: deployment,
    detached: clustered && process.platform !== "win32",
    env: {
      ...env,
      PORT: String(port),
      NITRO_PORT: String(port),
      HOST: "127.0.0.1",
      NITRO_SHUTDOWN_DISABLED: "",
      NITRO_SHUTDOWN_SIGNALS: "SIGTERM SIGINT",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  try {
    await waitForCondition(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Nuxt exited before serving eve.\n${output}`);
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(2_000),
          });
          await response.body?.cancel();
          return response.status === 200;
        } catch {
          return false;
        }
      },
      () => `Nuxt did not serve eve.\n${output}`,
      60_000,
    );
    if (pendingStartupPidPath) {
      await waitForCondition(
        async () => {
          backendPid = Number(await readFile(pendingStartupPidPath, "utf8").catch(() => "0"));
          return backendPid > 0;
        },
        () => `eve child did not start.\n${output}`,
        5_000,
      );
      expect(await readFile(join(deployment, "request-probe-installed"), "utf8")).toBe("installed");
      const markerPath = join(deployment, "request-started");
      await rm(markerPath, { force: true });
      const request = fetch(`http://127.0.0.1:${port}/eve/v1/health`, {
        signal: pendingRequest.signal,
      });
      void request.catch(() => undefined);
      await waitForCondition(
        async () => (await readFile(markerPath, "utf8").catch(() => "")) === "started",
        () => `Nuxt did not receive the pending eve request.\n${output}`,
        5_000,
      );
      child.kill("SIGTERM");
      await waitForCondition(
        () => {
          try {
            process.kill(backendPid!, 0);
            return false;
          } catch {
            return true;
          }
        },
        () => `Nuxt left its pending eve child running.\n${output}`,
        5_000,
      );
      const response = await request;
      expect(response.status).toBe(503);
      await response.body?.cancel();
      return;
    }
    // Do not poll eve: the first transport request must wait for startup.
    const health = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    expect(health.status, output).toBe(expectedStatus);
    if (expectedStatus === 200) {
      expect(await health.json()).toEqual(expect.objectContaining({ ok: true, status: "ready" }));
      expect(output).not.toContain("failed to start the eve production server");
    } else {
      expect(await health.text()).toBe("eve production server is unavailable.");
      expect(output).toContain("failed to start the eve production server");
      const retry = await fetch(`http://127.0.0.1:${port}/eve/v1/health`);
      expect(retry.status).toBe(503);
      await retry.body?.cancel();
    }
  } catch (error) {
    throw new Error(`Nuxt health check failed (expected ${expectedStatus}).\n${output}`, {
      cause: error,
    });
  } finally {
    pendingRequest.abort();
    if (clustered && process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
    await stopChildProcess(child);
    if (backendPid) {
      try {
        process.kill(backendPid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
  }
}

describe("framework-nuxt build", () => {
  it("does not manage eve during static generation or for a build-time external origin", async () => {
    const app = await scenarioApp(NUXT_EVE_SERVICE_DESCRIPTOR);
    const env = {
      ...process.env,
      VERCEL: "",
      EVE_NUXT_PRODUCTION_ORIGIN: "",
      NITRO_PRESET: "node-server",
    };
    const generated = await runPnpmCommand({
      args: ["exec", "nuxt", "generate"],
      cwd: app.appRoot,
      env: { ...env, NITRO_PRESET: undefined },
    });
    expect(generated.stdout + generated.stderr).not.toContain(
      "failed to start the eve production server",
    );
    expect(await readFile(join(app.appRoot, ".output/public/index.html"), "utf8")).toContain(
      "eve nuxt deployment",
    );

    const configPath = join(app.appRoot, "nuxt.config.ts");
    const originalConfig = await readFile(configPath, "utf8");
    for (const configured of [false, true]) {
      if (configured)
        await writeFile(
          configPath,
          originalConfig.replace(
            "telemetry: false,",
            'telemetry: false, nitro: { preset: "node-cluster" },',
          ),
        );
      try {
        await expect(
          runPnpmCommand({
            args: ["exec", "nuxt", "build"],
            cwd: app.appRoot,
            env: {
              ...env,
              NITRO_PRESET: configured ? undefined : "node-cluster",
              SERVER_PRESET: undefined,
            },
          }),
        ).rejects.toThrow(/EVE_NUXT_PRODUCTION_ORIGIN.*building Nuxt/);
      } finally {
        await writeFile(configPath, originalConfig);
      }
    }

    const backend = createHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, status: "ready" }));
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    try {
      const address = backend.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP port.");
      await runPnpmCommand({
        args: ["exec", "nuxt", "build"],
        cwd: app.appRoot,
        env: {
          ...env,
          NITRO_PRESET: "node-cluster",
          EVE_NUXT_PRODUCTION_ORIGIN: `http://127.0.0.1:${address.port}`,
        },
      });
      // No eve build exists here, and the origin variable is absent at runtime.
      await assertNuxtHealth(app.appRoot, {
        ...env,
        NITRO_CLUSTER_WORKERS: "2",
        EVE_NUXT_PRODUCTION_ORIGIN: undefined,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        backend.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 300_000);

  it("serves a relocated production eve build with the build-time port and portable root", async () => {
    const descriptor = NUXT_EVE_SERVICE_DESCRIPTOR;
    const app = await scenarioApp({
      ...descriptor,
      files: {
        ...descriptor.files,
        "backend/package.json":
          '{ "private": true, "type": "module", "dependencies": { "eve": "*" } }',
        "backend/agent/agent.mjs": descriptor.files["agent/agent.mjs"]!,
        "backend/agent/instructions.md": "You are a test agent.\n",
        "server/plugins/request-probe.ts": `import { writeFileSync } from "node:fs";
export default defineNitroPlugin((nitroApp) => {
  writeFileSync("request-probe-installed", "installed");
  // Observe dispatch before the readiness hook can block it.
  const callHook = nitroApp.hooks.callHook.bind(nitroApp.hooks);
  nitroApp.hooks.callHook = (name, ...args) => {
    if (name === "request" && args[0].path === "/eve/v1/health") {
      writeFileSync("request-started", "started");
    }
    return callHook(name, ...args);
  };
});`,
        "nuxt.config.ts": `export default defineNuxtConfig({
  compatibilityDate: "2026-05-27",
  eve: { eveRoot: "backend" },
  modules: ["eve/nuxt"],
  nitro: { plugins: ["./plugins/request-probe.ts"] },
  routeRules: { "/": { prerender: true } },
  telemetry: false,
});`,
      },
    });
    const evePort = await findFreePort();
    const env = {
      ...process.env,
      NITRO_PRESET: "node-server",
      VERCEL: "",
      EVE_NUXT_PRODUCTION_ORIGIN: "",
      EVE_NUXT_PRODUCTION_PORT: String(evePort),
    };
    await runPnpmCommand({
      args: [
        "exec",
        process.execPath,
        join(app.appRoot, "node_modules/eve/bin/eve.js"),
        "build",
        "--skip-sandbox-prewarm",
      ],
      cwd: join(app.appRoot, "backend"),
      env,
    });
    const build = await runPnpmCommand({
      args: ["exec", "nuxt", "build"],
      cwd: app.appRoot,
      env,
    });
    expect(build.stdout + build.stderr).not.toContain("failed to start the eve production server");

    // No ancestor node_modules can mask missing traced runtime imports.
    const deployment = await mkdtemp(join(tmpdir(), "eve-nuxt-production-"));
    try {
      await rename(join(app.appRoot, ".output"), join(deployment, ".output"));
      await rename(join(app.appRoot, "backend"), join(deployment, "backend"));
      const serverDirectory = join(deployment, "backend/.output/server");
      const entry = join(serverDirectory, "index.mjs");
      await writeFile(
        entry,
        `import { writeFileSync as writeFixturePid } from "node:fs";
writeFixturePid("startup-pid", String(process.pid));
if (process.env.TEST_EVE_START_FAILURE) throw new Error("fixture startup failure");
await new Promise((resolve) => setTimeout(resolve, process.env.TEST_EVE_START_DELAY ? 60000 : 1500));
${await readFile(entry, "utf8")}`,
      );
      await assertNuxtHealth(
        deployment,
        { ...env, TEST_EVE_START_DELAY: "1" },
        200,
        join(deployment, "backend/startup-pid"),
      );
      for (const root of [undefined, "./relocated-agent"]) {
        if (root) await rename(join(deployment, "backend"), join(deployment, "relocated-agent"));
        await assertNuxtHealth(deployment, {
          ...env,
          EVE_NUXT_PRODUCTION_PORT: undefined,
          EVE_NUXT_PRODUCTION_ROOT: root,
        });
      }
      await assertNuxtHealth(
        deployment,
        {
          ...env,
          EVE_NUXT_PRODUCTION_ROOT: "./relocated-agent",
          TEST_EVE_START_FAILURE: "1",
        },
        503,
      );
      await assertNuxtHealth(
        deployment,
        {
          ...env,
          EVE_NUXT_PRODUCTION_ROOT: "./missing-agent",
        },
        503,
      );
      const occupant = createHttpServer((_request, response) => response.end("not eve"));
      await new Promise<void>((resolve) => occupant.listen(evePort, "127.0.0.1", resolve));
      try {
        await assertNuxtHealth(
          deployment,
          {
            ...env,
            EVE_NUXT_PRODUCTION_ROOT: "./relocated-agent",
          },
          503,
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          occupant.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      await rm(deployment, { recursive: true, force: true });
    }
  }, 300_000);

  it("emits the eve service and route into the Vercel Build Output", async () => {
    const app = await scenarioApp(NUXT_EVE_SERVICE_DESCRIPTOR);

    // Build the Nuxt app directly with the env a real Vercel build container
    // always provides. `VERCEL` triggers both Nitro's Vercel preset (via
    // std-env provider detection) and the eve module's service generation;
    // `NITRO_PRESET` pins the preset so the assertion does not depend on
    // detection heuristics. `vercel build` is intentionally not used here: run
    // unauthenticated it strips these system env vars, so Nitro would fall back
    // to the node-server preset and emit no Build Output. Vercel's own
    // assembly of the generated service is covered by the Next.js scenario.
    await runPnpmCommand({
      args: ["exec", "nuxt", "build"],
      cwd: app.appRoot,
      env: {
        ...process.env,
        NITRO_PRESET: "vercel",
        VERCEL: "1",
        VERCEL_ENV: "production",
      },
    });

    const { routes, services } = await readVercelOutputConfig(
      join(app.appRoot, ".vercel", "output"),
    );
    const eveRouteIndex = routes.findIndex(isEveServiceRoute);
    const filesystemIndex = routes.findIndex(isFilesystemHandle);

    expect(routes[eveRouteIndex]).toEqual(
      expect.objectContaining({
        destination: { service: "eve", type: "service" },
        src: "^/eve/v1/(.*)$",
      }),
    );
    if (filesystemIndex !== -1) {
      expect(eveRouteIndex).toBeLessThan(filesystemIndex);
    }
    expect(services.eve).toEqual(
      expect.objectContaining({
        framework: "eve",
        root: ".eve/vercel-services/eve",
      }),
    );
  }, 300_000);
});
