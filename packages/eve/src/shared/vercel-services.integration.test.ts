import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#shared/resolve-eve-binary.js", async () => {
  const { join } = await import("node:path");
  return {
    resolveEveBinaryPath: (root: string) => join(root, "node_modules", "eve", "bin", "eve.js"),
  };
});

import { resolveFrameworkAgents } from "#shared/framework-agents.js";
import { ensureEveVercelServicesConfig, mergeEveVercelConfig } from "#shared/vercel-services.js";

const roots: string[] = [];
async function createTempHostRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-vercel-services-"));
  roots.push(root);
  return root;
}

async function ensureConfig(hostRoot: string, eveRoot = hostRoot, eveBuildCommand?: string) {
  return ensureEveVercelServicesConfig({
    agents: await resolveFrameworkAgents(eveRoot),
    frameworkName: "Test",
    hostRoot,
    eveBuildCommand,
  });
}

async function writeConfig(root: string, config: unknown): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "vercel.json"), JSON.stringify(config));
}

async function createWorkspace(root: string): Promise<void> {
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "0.0.0" } }));
  for (const name of ["billing", "support"]) {
    await mkdir(join(root, "agents", name, "agent"), { recursive: true });
    await writeFile(join(root, "agents", name, "agent", "agent.ts"), "export default {};\n");
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ensureEveVercelServicesConfig", () => {
  it.each([undefined, "pnpm build:eve"])(
    "prepares standalone builds with command %s",
    async (command) => {
      const hostRoot = await createTempHostRoot();
      const result = await ensureConfig(hostRoot, hostRoot, command);
      if (result.mode !== "generated") throw new Error("Expected generated services");
      const config = mergeEveVercelConfig(undefined, result);
      expect(config.services?.eve?.buildCommand).toBe(
        "cd '../../..' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='.vercel/output' && " +
          (command ?? "node 'node_modules/eve/bin/eve.js' build"),
      );
      expect((await stat(join(hostRoot, ".eve/vercel-services/eve"))).isDirectory()).toBe(true);
    },
  );

  it("generates isolated builds for every discovered workspace member", async () => {
    const hostRoot = await createTempHostRoot();
    await createWorkspace(hostRoot);
    const result = await ensureConfig(hostRoot);
    if (result.mode !== "generated") throw new Error("Expected generated services");
    const config = mergeEveVercelConfig(undefined, result);
    expect(Object.keys(config.services!)).toEqual(["eve-billing", "eve-support"]);
    expect(config.routes?.map((route) => (route as { src: string }).src)).toEqual([
      "^/eve/billing/v1/(.*)$",
      "^/eve/billing/?$",
      "^/eve/support/v1/(.*)$",
      "^/eve/support/?$",
    ]);
    expect(config.services?.["eve-support"]?.buildCommand).toContain(
      "export EVE_PUBLIC_ROUTE_PREFIX='/eve/support'",
    );
    expect(config.services?.["eve-support"]?.buildCommand).toContain(
      "export EVE_INTERNAL_AGENT_WORKSPACE_MEMBER=1",
    );
    for (const name of ["billing", "support"]) {
      expect((await stat(join(hostRoot, `.eve/vercel-services/eve-${name}`))).isDirectory()).toBe(
        true,
      );
    }
  });

  it("resolves relative paths for an eve app in a subdirectory", async () => {
    const hostRoot = await createTempHostRoot();
    const result = await ensureConfig(hostRoot, join(hostRoot, "agent"));
    if (result.mode !== "generated") throw new Error("Expected generated services");
    expect(mergeEveVercelConfig(undefined, result).services?.eve?.buildCommand).toBe(
      "cd '../../../agent' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../.vercel/output' && node '../node_modules/eve/bin/eve.js' build",
    );
  });

  it.each(["record", "array"])(
    "accepts custom-named authored standalone services (%s)",
    async (shape) => {
      const hostRoot = await createTempHostRoot();
      const agent = { framework: "eve", root: "agent" };
      await writeConfig(hostRoot, {
        services: shape === "record" ? { agent } : [{ name: "agent", ...agent }],
      });
      expect(await ensureConfig(hostRoot)).toEqual({ mode: "root" });
      await expect(stat(join(hostRoot, ".eve/vercel-services"))).rejects.toThrow();
    },
  );

  it("requires an authored service for every workspace member", async () => {
    const hostRoot = await createTempHostRoot();
    await createWorkspace(hostRoot);
    const services = { "eve-billing": { framework: "eve", root: "agents/billing" } };
    await writeConfig(hostRoot, { services });
    await expect(ensureConfig(hostRoot)).rejects.toThrow(
      /cannot add a generated service for support/,
    );
    await writeConfig(hostRoot, {
      services: { ...services, "eve-support": { framework: "eve", root: "agents/support" } },
    });
    expect(await ensureConfig(hostRoot)).toEqual({ mode: "root" });
  });

  it("reads linked project services but prefers the host's services", async () => {
    const projectRoot = await createTempHostRoot();
    const hostRoot = join(projectRoot, "apps/web");
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(join(projectRoot, ".vercel/project.json"), "{}");
    await mkdir(hostRoot, { recursive: true });
    await writeConfig(projectRoot, { services: { agent: { framework: "eve" } } });
    expect(await ensureConfig(hostRoot)).toEqual({ mode: "root" });
    await writeConfig(hostRoot, { services: { web: { framework: "nuxtjs" } } });
    await expect(ensureConfig(hostRoot)).rejects.toThrow(/already defines services/);
  });

  it("warns about experimentalServices only when stable services are absent", async () => {
    const hostRoot = await createTempHostRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeConfig(hostRoot, { experimentalServices: { eve: { framework: "eve" } } });
    expect((await ensureConfig(hostRoot)).mode).toBe("generated");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("experimentalServices"));
    warn.mockClear();
    await writeConfig(hostRoot, {
      experimentalServices: {},
      services: { eve: { framework: "eve" } },
    });
    expect(await ensureConfig(hostRoot)).toEqual({ mode: "root" });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { config: ["not an object"], error: /must contain a JSON object/ },
    {
      config: { services: { agent: { framework: "eve", routes: [null] } } },
      error: /routes\[0\].*JSON object/,
    },
  ])("rejects malformed authored config: $config", async ({ config, error }) => {
    const hostRoot = await createTempHostRoot();
    await writeConfig(hostRoot, config);
    await expect(ensureConfig(hostRoot)).rejects.toThrow(error);
  });
});
