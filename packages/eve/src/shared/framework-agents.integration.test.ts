import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFrameworkAgents } from "./framework-agents.js";

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-framework-agents-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ dependencies: { eve: "0.0.0" } })}\n`,
  );
  await Promise.all(
    ["billing", "support"].map(async (name) => {
      const agentRoot = join(root, "agents", name, "agent");
      await mkdir(agentRoot, { recursive: true });
      await writeFile(join(agentRoot, "agent.ts"), "export default {};\n");
    }),
  );
  return root;
}

describe("resolveFrameworkAgents", () => {
  it("discovers workspace members with named public routes", async () => {
    const root = await createWorkspace();

    await expect(resolveFrameworkAgents(root)).resolves.toEqual([
      {
        appRoot: join(root, "agents", "billing"),
        name: "billing",
        publicRoutePrefix: "/eve/billing",
        transportRoutePrefix: "/eve/billing/v1",
        workspaceMember: true,
      },
      {
        appRoot: join(root, "agents", "support"),
        name: "support",
        publicRoutePrefix: "/eve/support",
        transportRoutePrefix: "/eve/support/v1",
        workspaceMember: true,
      },
    ]);
  });
});
