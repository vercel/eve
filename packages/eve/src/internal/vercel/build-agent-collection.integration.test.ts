import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("#shared/resolve-eve-binary.js", () => ({
  resolveEveBinaryPath: (root: string) => join(root, "node_modules", "eve", "bin", "eve.js"),
}));

import { loadAgentCollection } from "#internal/agent-collection.js";
import { buildAgentCollection } from "#internal/vercel/build-agent-collection.js";

async function createCollection(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-collection-build-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ eve: { collection: true }, packageManager: "pnpm@10.0.0", private: true }),
  );
  await Promise.all([
    mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
    mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
  ]);
  return root;
}

describe("buildAgentCollection", () => {
  it("emits peer services and canonical public routes", async () => {
    const root = await createCollection();
    const collection = await loadAgentCollection(root);
    expect(collection).toBeDefined();

    const output = await buildAgentCollection(collection);
    const config = JSON.parse(await readFile(join(output, "config.json"), "utf8"));

    expect(config.routes).toEqual([
      {
        destination: { service: "eve-research", type: "service" },
        src: "^/eve/agents/research/eve/v1/(.*)$",
      },
      {
        destination: { service: "eve-support", type: "service" },
        src: "^/eve/agents/support/eve/v1/(.*)$",
      },
    ]);
    expect(config.services["eve-support"]).toEqual({
      buildCommand:
        "cd '../../../agents/support' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../../.eve/vercel-services/eve-support/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && export EVE_PUBLIC_ROUTE_PREFIX='/eve/agents/support' && node 'node_modules/eve/bin/eve.js' build",
      framework: "eve",
      root: ".eve/vercel-services/eve-support",
      routePrefix: "/eve/agents/support",
      routes: [
        {
          src: "^/eve/agents/support/eve/v1/(.*)$",
          transforms: [{ args: "/eve/v1/$1", op: "set", type: "request.path" }],
        },
      ],
    });
  });

  it("keeps digit-bearing public names while encoding the generated service name", async () => {
    const root = await createCollection();
    await mkdir(join(root, "agents", "support2", "agent"), { recursive: true });
    const collection = await loadAgentCollection(root);
    const output = await buildAgentCollection(collection);
    const config = JSON.parse(await readFile(join(output, "config.json"), "utf8"));
    const supportServiceName = Object.keys(config.services).find((name) =>
      name.startsWith("eve-support-"),
    );

    expect(supportServiceName).toMatch(/^eve-support-[a-z]+$/);
    expect(config.routes).toContainEqual({
      destination: { service: supportServiceName, type: "service" },
      src: "^/eve/agents/support2/eve/v1/(.*)$",
    });
  });

  it("refuses to assemble an authored graph", async () => {
    const root = await createCollection();
    await writeFile(join(root, "vercel.json"), JSON.stringify({ services: {} }));
    const collection = await loadAgentCollection(root);
    await expect(buildAgentCollection(collection)).rejects.toThrow(/Run `vercel build`/);
  });
});
