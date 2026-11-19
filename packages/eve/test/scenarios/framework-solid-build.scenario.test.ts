import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createSolidEveServiceDescriptor } from "../../src/internal/testing/scenario-apps/solid-eve-service.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const scenarioApp = useScenarioApp();
const execFileAsync = promisify(execFile);

interface VercelOutputConfig {
  readonly routes: readonly {
    readonly dest?: string;
    readonly handle?: string;
    readonly src?: string;
  }[];
  readonly services: Record<string, unknown>;
}

async function buildForVercel(
  appRoot: string,
  env: Record<string, string> = {},
): Promise<VercelOutputConfig> {
  await runPnpmCommand({
    args: ["exec", "vite", "build"],
    cwd: appRoot,
    env: { ...process.env, ...env, VERCEL: "1" },
  });
  return JSON.parse(
    await readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
  ) as VercelOutputConfig;
}

describe("framework-solid build", () => {
  it("builds the SSR server bundle beside eveVite(), and renders eve/solid on the server", async () => {
    const app = await scenarioApp(createSolidEveServiceDescriptor({ ssr: true }));

    await runPnpmCommand({ args: ["exec", "vite", "build"], cwd: app.appRoot });

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { handleRequest } = await import("./dist/server/server.js");
const response = await handleRequest(new Request("http://localhost/"));
process.stdout.write(await response.text());`,
      ],
      { cwd: app.appRoot },
    );
    expect(stdout).toMatch(
      /<main [^>]*data-status="idle"[^>]*>(?:<!--[^>]*-->)?0(?:<!--[^>]*-->)? messages<\/main>/,
    );
  }, 300_000);

  it("adds the eve service and route to the Build Output nitro() writes on Vercel", async () => {
    const app = await scenarioApp(createSolidEveServiceDescriptor({ nitro: true, ssr: true }));

    const config = await buildForVercel(app.appRoot, { NITRO_PRESET: "vercel" });

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

  it("deploys a client-rendered app as a static Build Output with an SPA fallback on Vercel", async () => {
    const app = await scenarioApp(createSolidEveServiceDescriptor({ ssr: false }));

    const config = await buildForVercel(app.appRoot);

    await access(join(app.appRoot, ".vercel", "output", "static", "index.html"));
    expect(config.routes).toEqual([
      { destination: { service: "eve", type: "service" }, src: "^/eve/v1/(.*)$" },
      { handle: "filesystem" },
      { dest: "/index.html", src: "/(.*)" },
    ]);
    expect(config.services.eve).toEqual(
      expect.objectContaining({ framework: "eve", root: ".eve/vercel-services/eve" }),
    );
  }, 300_000);
});
