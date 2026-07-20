import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ScenarioAppDescriptor } from "../../src/internal/testing/scenario-app.js";
import { createNextEveProxyDescriptor } from "../../src/internal/testing/scenario-apps/next-eve-proxy.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const VERCEL_GENERATED_SERVICES_VERSION = "55.0.0";
const VERCEL_PNPM_10_PROJECT_CREATED_AT = Date.UTC(2026, 6, 13);
const scenarioApp = useScenarioApp();

const NEXT_EVE_PROXY_DESCRIPTOR = createNextEveProxyDescriptor({
  installDependencies: true,
  vercelVersion: VERCEL_GENERATED_SERVICES_VERSION,
});
const NEXT_EVE_MIDDLEWARE_DESCRIPTOR = {
  ...NEXT_EVE_PROXY_DESCRIPTOR,
  files: {
    ...NEXT_EVE_PROXY_DESCRIPTOR.files,
    ".vercel/project.json": `${JSON.stringify(
      {
        orgId: "team_eve_scenario",
        projectId: "prj_eve_scenario",
        projectName: "next-eve-middleware",
        settings: {
          buildCommand: "pnpm exec next build",
          createdAt: VERCEL_PNPM_10_PROJECT_CREATED_AT,
          framework: "nextjs",
          nodeVersion: "24.x",
          outputDirectory: null,
          rootDirectory: null,
        },
      },
      null,
      2,
    )}\n`,
  },
  name: "next-eve-middleware",
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

describe("framework-next build", () => {
  it("builds the Next.js framework fixture after regenerating eve dist", async () => {
    await runPnpmCommand({
      args: ["--filter", "framework-next", "build"],
      cwd: REPO_ROOT,
    });
  }, 180_000);

  it("preserves Next middleware when Vercel assembles the generated eve service", async () => {
    const app = await scenarioApp(NEXT_EVE_MIDDLEWARE_DESCRIPTOR);

    await runPnpmCommand({
      args: ["exec", "vercel", "build", "--yes"],
      cwd: app.appRoot,
    });

    const outputRoot = join(app.appRoot, ".vercel", "output");
    const routes = await readVercelOutputRoutes(outputRoot);

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ middlewarePath: "/_middleware" }),
        expect.objectContaining({
          destination: { service: "eve", type: "service" },
          src: "^/eve/v1/(.*)$",
        }),
      ]),
    );
    await expect(
      access(join(outputRoot, "functions", "_middleware.func", ".vc-config.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(outputRoot, "services", "eve", "functions", "__server.func", ".vc-config.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(
        join(outputRoot, "services", "eve", "functions", "_middleware.func", ".vc-config.json"),
      ),
    ).resolves.toBeUndefined();
  }, 240_000);
});
