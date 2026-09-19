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
  it("creates the Web Chat tsconfig for a fresh app", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-web-project-"));

    await prepareWebRegistryProject(workspaceRoot);

    const tsconfig = JSON.parse(
      await readFile(join(workspaceRoot, "apps", "web", "tsconfig.json"), "utf8"),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };
    expect(tsconfig.compilerOptions?.paths?.["@/*"]).toEqual(["./*"]);
  });
});
