import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveFrameworkAgents } from "./framework-agents.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(names = ["billing", "support"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-framework-agents-"));
  roots.push(root);
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ dependencies: { eve: "0.0.0" } })}\n`,
  );
  await Promise.all(
    names.map(async (name) => {
      const agentRoot = join(root, "agents", name, "agent");
      await mkdir(agentRoot, { recursive: true });
      await writeFile(join(agentRoot, "agent.ts"), "export default {};\n");
    }),
  );
  return root;
}

describe("resolveFrameworkAgents", () => {
  it("rejects an empty workspace with an actionable error", async () => {
    const root = await createWorkspace([]);
    await expect(resolveFrameworkAgents(root)).rejects.toThrow(
      `Found no eve workspace agents under ${join(root, "agents")}. Add an agent before starting the frontend.`,
    );
  });

  it("mounts a selected member as a standalone agent", async () => {
    const root = await createWorkspace();
    const member = join(root, "agents", "support");
    await expect(resolveFrameworkAgents(member)).resolves.toEqual([
      { appRoot: member, publicRoutePrefix: "", transportRoutePrefix: "/eve/v1" },
    ]);
  });

  it("discovers workspace members with named public routes", async () => {
    const root = await createWorkspace();

    await expect(resolveFrameworkAgents(`${root}/`)).resolves.toEqual([
      {
        appRoot: join(root, "agents", "billing"),
        name: "billing",
        publicRoutePrefix: "/eve/billing",
        transportRoutePrefix: "/eve/billing/v1",
      },
      {
        appRoot: join(root, "agents", "support"),
        name: "support",
        publicRoutePrefix: "/eve/support",
        transportRoutePrefix: "/eve/support/v1",
      },
    ]);
  });
});
