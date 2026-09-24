import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareWebRegistryProject, readRegistryConfig } from "./registry-project.js";

describe("readRegistryConfig", () => {
  it("reads registry mappings from an agent workspace package", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-workspace-"));
    const agentRoot = join(workspaceRoot, "agents", "support");
    await mkdir(join(agentRoot, "agent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        dependencies: { eve: "*" },
        registries: { "@acme": "https://example.com/r/{name}.json" },
      }),
    );

    await expect(readRegistryConfig(agentRoot)).resolves.toEqual({
      registries: { "@acme": "https://example.com/r/{name}.json" },
    });
  });
});

describe("prepareWebRegistryProject", () => {
  it("leaves a fresh app for the registry transaction to create", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-web-project-"));
    const tsconfigPath = join(workspaceRoot, "apps", "web", "tsconfig.json");

    await prepareWebRegistryProject(workspaceRoot);

    await expect(readFile(tsconfigPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
