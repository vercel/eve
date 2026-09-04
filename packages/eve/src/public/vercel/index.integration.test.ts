import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("#shared/resolve-eve-binary.js", () => ({
  resolveEveBinaryPath: (root: string) => join(root, "node_modules", "eve", "bin", "eve.js"),
}));

import { withEve } from "./index.js";

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-vercel-config-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { eve: "*" }, packageManager: "pnpm@10.0.0", private: true }),
  );
  await Promise.all([
    mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
    mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
  ]);
  return root;
}

describe("withEve", () => {
  it("composes workspace agents with authored Vercel services and routes", async () => {
    const root = await createWorkspace();
    const config = await withEve(
      {
        crons: [{ path: "/api/dispatch", schedule: "* * * * *" }],
        routes: [
          { destination: { service: "web", type: "service" }, src: "^/api/(.*)$" },
          { handle: "filesystem" },
        ],
        services: { web: { framework: "nextjs", root: "apps/web" } },
      },
      { root },
    );

    expect(config.crons).toEqual([{ path: "/api/dispatch", schedule: "* * * * *" }]);
    expect(config.routes).toEqual([
      { destination: { service: "web", type: "service" }, src: "^/api/(.*)$" },
      {
        destination: { service: "eve-research", type: "service" },
        src: "^/research/eve/v1/(.*)$",
      },
      {
        destination: { service: "eve-support", type: "service" },
        src: "^/support/eve/v1/(.*)$",
      },
      { handle: "filesystem" },
    ]);
    expect(config.services.web).toEqual({ framework: "nextjs", root: "apps/web" });
    expect(config.services["eve-support"]).toEqual({
      buildCommand:
        "cd '../../../agents/support' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../../.eve/vercel-services/eve-support/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && export EVE_PUBLIC_ROUTE_PREFIX='/support' && export EVE_INTERNAL_AGENT_WORKSPACE_MEMBER=1 && node 'node_modules/eve/bin/eve.js' build",
      framework: "eve",
      root: ".eve/vercel-services/eve-support",
      routes: [
        {
          src: "^/support/eve/v1/(.*)$",
          transforms: [{ args: "/eve/v1/$1", op: "set", type: "request.path" }],
        },
      ],
    });
    await expect(
      access(join(root, ".eve", "vercel-services", "eve-support")),
    ).resolves.toBeUndefined();
  });

  it("does not modify the root Build Output", async () => {
    const root = await createWorkspace();
    const marker = join(root, ".vercel", "output", "services", "web", "config.json");
    await mkdir(join(marker, ".."), { recursive: true });
    await writeFile(marker, "web output");

    await withEve({}, { root });

    await expect(access(marker)).resolves.toBeUndefined();
  });

  it("reserves generated service names and transport routes", async () => {
    const root = await createWorkspace();

    await expect(
      withEve({ services: { "eve-support": { framework: "nextjs" } } }, { root }),
    ).rejects.toThrow(/eve-support.*reserved/);
    await expect(
      withEve({ routes: [{ src: "^/support/eve/v1/(.*)$" }] }, { root }),
    ).rejects.toThrow(/route.*support.*reserved/);
  });

  it("requires an eve workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-vercel-config-standalone-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } }));
    await mkdir(join(root, "agent"), { recursive: true });

    await expect(withEve({}, { root })).rejects.toThrow(/workspace root/);
  });
});
