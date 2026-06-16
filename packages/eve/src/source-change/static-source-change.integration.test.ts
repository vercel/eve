import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { createStaticSourceChange } from "#source-change/static-source-change.js";

const SCAFFOLD = `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
});
`;

describe("createStaticSourceChange.updateModelName", () => {
  let createdRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(createdRoots.map((root) => rm(root, { recursive: true, force: true })));
    createdRoots = [];
  });

  async function scaffoldAgent(source: string = SCAFFOLD) {
    const appRoot = await mkdtemp(join(tmpdir(), "ash-static-source-change-"));
    createdRoots.push(appRoot);
    const agentRoot = join(appRoot, "agent");
    await mkdir(agentRoot, { recursive: true });
    await writeFile(join(agentRoot, "agent.ts"), source, "utf8");
    const manifest = createAgentSourceManifest({
      appRoot,
      agentRoot,
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
    });
    return { agentRoot, manifest };
  }

  it("rewrites the model in the on-disk agent.ts", async () => {
    const { agentRoot, manifest } = await scaffoldAgent();

    const result = await createStaticSourceChange(manifest).updateModelName(
      "anthropic/claude-opus-4.6",
    );

    expect(result.kind).toBe("applied");
    const written = await readFile(join(agentRoot, "agent.ts"), "utf8");
    expect(written).toContain(`model: "anthropic/claude-opus-4.6"`);
    expect(written).toContain(`import { defineAgent } from "eve"`);
  });

  it("bails with a source location when the value is not a literal", async () => {
    const { manifest } = await scaffoldAgent(
      `export default defineAgent({ model: process.env.MODEL ?? "a/b" });\n`,
    );

    const result = await createStaticSourceChange(manifest).updateModelName("c/d");

    expect(result.kind).toBe("bail");
    if (result.kind !== "bail") return;
    expect(result.at.logicalPath).toBe("agent.ts");
  });

  it("bails when the agent has no config module", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "ash-static-source-change-"));
    createdRoots.push(appRoot);
    const manifest = createAgentSourceManifest({ appRoot, agentRoot: join(appRoot, "agent") });

    const result = await createStaticSourceChange(manifest).updateModelName("c/d");

    expect(result.kind).toBe("bail");
  });
});
