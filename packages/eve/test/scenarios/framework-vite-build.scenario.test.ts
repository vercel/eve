import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createViteEveServiceDescriptor } from "../../src/internal/testing/scenario-apps/vite-eve-service.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const scenarioApp = useScenarioApp();

describe("framework-vite build", () => {
  it("adds the eve service and route to the app's Vercel Build Output", async () => {
    const app = await scenarioApp(createViteEveServiceDescriptor());

    await runPnpmCommand({
      args: ["exec", "vite", "build"],
      cwd: app.appRoot,
      env: { ...process.env, VERCEL: "1" },
    });

    const configPath = join(app.appRoot, ".vercel", "output", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      readonly routes: readonly { readonly handle?: string; readonly src?: string }[];
      readonly services: Record<string, unknown>;
    };
    const eveRouteIndex = config.routes.findIndex((route) => route.src === "^/eve/v1/(.*)$");
    const filesystemIndex = config.routes.findIndex((route) => route.handle === "filesystem");

    expect(config.routes[eveRouteIndex]).toEqual({
      destination: { service: "eve", type: "service" },
      src: "^/eve/v1/(.*)$",
    });
    expect(filesystemIndex).not.toBe(-1);
    expect(eveRouteIndex).toBeLessThan(filesystemIndex);
    expect(config.services.eve).toEqual(
      expect.objectContaining({ framework: "eve", root: ".eve/vercel-services/eve" }),
    );
  }, 300_000);
});
