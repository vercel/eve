import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ScenarioAppDescriptor } from "../../src/internal/testing/scenario-app.js";
import { createNuxtEveServiceDescriptor } from "../../src/internal/testing/scenario-apps/nuxt-eve-service.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const VERCEL_GENERATED_SERVICES_VERSION = "55.0.0";
const VERCEL_PNPM_10_PROJECT_CREATED_AT = Date.UTC(2026, 6, 13);
const scenarioApp = useScenarioApp();

const NUXT_EVE_SERVICE_DESCRIPTOR = createNuxtEveServiceDescriptor({
  installDependencies: true,
  vercelVersion: VERCEL_GENERATED_SERVICES_VERSION,
});
const NUXT_EVE_VERCEL_DESCRIPTOR = {
  ...NUXT_EVE_SERVICE_DESCRIPTOR,
  files: {
    ...NUXT_EVE_SERVICE_DESCRIPTOR.files,
    ".vercel/project.json": `${JSON.stringify(
      {
        orgId: "team_eve_scenario",
        projectId: "prj_eve_scenario",
        projectName: "nuxt-eve-service",
        settings: {
          buildCommand: "pnpm exec nuxt build",
          createdAt: VERCEL_PNPM_10_PROJECT_CREATED_AT,
          framework: "nuxtjs",
          nodeVersion: "24.x",
          outputDirectory: null,
          rootDirectory: null,
        },
      },
      null,
      2,
    )}\n`,
  },
} satisfies ScenarioAppDescriptor;

async function readVercelOutputRoutes(outputRoot: string): Promise<readonly unknown[]> {
  const config: unknown = JSON.parse(await readFile(join(outputRoot, "config.json"), "utf8"));

  if (
    typeof config !== "object" ||
    config === null ||
    !("routes" in config) ||
    !Array.isArray(config.routes)
  ) {
    throw new Error("Expected Vercel Build Output config.json to contain a routes array.");
  }

  return config.routes;
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

describe("framework-nuxt build", () => {
  it("builds the Nuxt framework fixture after regenerating eve dist", async () => {
    await runPnpmCommand({
      args: ["--filter", "framework-nuxt", "build"],
      cwd: REPO_ROOT,
    });
  }, 300_000);

  it("routes the eve service when Vercel assembles the generated Build Output", async () => {
    const app = await scenarioApp(NUXT_EVE_VERCEL_DESCRIPTOR);

    // On real Vercel infra the build container always sets VERCEL/VERCEL_ENV,
    // which is how Nitro selects its Vercel preset (and how the eve module
    // knows to generate services). `vercel build` run in CI is unauthenticated
    // and cannot pull those system env vars, so set them explicitly to emulate
    // the deployment environment; otherwise Nitro falls back to the node-server
    // preset and never emits Build Output.
    await runPnpmCommand({
      args: ["exec", "vercel", "build", "--yes"],
      cwd: app.appRoot,
      env: {
        ...process.env,
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_TARGET_ENV: "production",
      },
    });

    const outputRoot = join(app.appRoot, ".vercel", "output");
    const routes = await readVercelOutputRoutes(outputRoot);
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
    await expect(
      access(join(outputRoot, "services", "eve", "functions", "__server.func", ".vc-config.json")),
    ).resolves.toBeUndefined();
  }, 360_000);
});
