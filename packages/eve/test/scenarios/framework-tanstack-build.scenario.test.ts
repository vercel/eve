import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTanStackEveServiceDescriptor } from "../../src/internal/testing/scenario-apps/tanstack-eve-service.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const scenarioApp = useScenarioApp();

const TANSTACK_EVE_SERVICE_DESCRIPTOR = createTanStackEveServiceDescriptor({
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

describe("framework-tanstack build", () => {
  it("emits the eve service and route into the Vercel Build Output", async () => {
    const app = await scenarioApp(TANSTACK_EVE_SERVICE_DESCRIPTOR);

    // `VERCEL` triggers the eve plugin's service generation. `NITRO_PRESET`
    // pins Nitro's Vercel preset so the assertion does not depend on provider
    // detection, which prefers the CI provider over `VERCEL`.
    await runPnpmCommand({
      args: ["exec", "vite", "build"],
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
    const eveRouteIndex = routes.findIndex(
      (route) =>
        typeof route === "object" &&
        route !== null &&
        "src" in route &&
        route.src === "^/eve/v1/(.*)$" &&
        "destination" in route,
    );
    const userCatchAllIndex = routes.findIndex(
      (route) =>
        typeof route === "object" && route !== null && "src" in route && route.src === "/(.*)",
    );
    const filesystemIndex = routes.findIndex(
      (route) =>
        typeof route === "object" &&
        route !== null &&
        "handle" in route &&
        route.handle === "filesystem",
    );

    expect(routes[eveRouteIndex]).toEqual(
      expect.objectContaining({
        destination: { service: "eve", type: "service" },
        src: "^/eve/v1/(.*)$",
      }),
    );
    expect(userCatchAllIndex).not.toBe(-1);
    expect(eveRouteIndex).toBeLessThan(userCatchAllIndex);
    expect(filesystemIndex).not.toBe(-1);
    expect(eveRouteIndex).toBeLessThan(filesystemIndex);
    expect(services.eve).toEqual(
      expect.objectContaining({
        framework: "eve",
        root: ".eve/vercel-services/eve",
      }),
    );
  }, 300_000);

  it("builds the eve app from the TanStack Start project root", async () => {
    const app = await scenarioApp(TANSTACK_EVE_SERVICE_DESCRIPTOR);

    // The generated Vercel service runs `eve build` in the host root. Nitro
    // must not mistake that root for a Vite app because of its vite.config.
    await runPnpmCommand({
      args: ["exec", "eve", "build", "--skip-sandbox-prewarm"],
      cwd: app.appRoot,
    });

    const serverRoot = join(app.appRoot, ".output", "server");
    await expect(readFile(join(serverRoot, "index.mjs"), "utf8")).resolves.toEqual(
      expect.any(String),
    );

    // Building through the host's Vite config would bundle TanStack Start's
    // SSR output into eve's server.
    const serverEntries = await readdir(serverRoot);
    expect(serverEntries).not.toContain("_ssr");
    expect(serverEntries.filter((entry) => entry.startsWith("_tanstack-start-manifest"))).toEqual(
      [],
    );
  }, 300_000);
});
