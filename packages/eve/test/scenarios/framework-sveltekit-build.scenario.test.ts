import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createSvelteKitEveServiceDescriptor } from "../../src/internal/testing/scenario-apps/sveltekit-eve-service.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const scenarioApp = useScenarioApp();

const SVELTEKIT_EVE_SERVICE_DESCRIPTOR = createSvelteKitEveServiceDescriptor({
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

describe("framework-sveltekit build", () => {
  it("builds the SvelteKit framework fixture against the workspace eve dist", async () => {
    await runPnpmCommand({
      args: ["--filter", "framework-sveltekit", "build"],
      cwd: REPO_ROOT,
    });
  }, 300_000);

  it("emits the eve service and route into the Vercel Build Output", async () => {
    const app = await scenarioApp(SVELTEKIT_EVE_SERVICE_DESCRIPTOR);

    await runPnpmCommand({
      args: ["exec", "vite", "build"],
      cwd: app.appRoot,
      env: {
        ...process.env,
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
