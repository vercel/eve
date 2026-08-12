import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryProjectSource } from "#discover/project-source.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { resolveAgentCollection } from "#internal/agent-collection.js";
import { resolveEveProjectContext } from "#internal/project-context.js";

async function createCollection(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-collection-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ eve: { collection: true }, private: true }),
  );
  await Promise.all([
    mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
    mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
  ]);
  return root;
}

describe("resolveAgentCollection", () => {
  it("discovers strict direct children in deterministic order", async () => {
    const root = await createCollection();
    await expect(resolveAgentCollection(root)).resolves.toMatchObject({
      members: [
        { name: "research", appRoot: join(root, "agents", "research") },
        { name: "support", appRoot: join(root, "agents", "support") },
      ],
      root,
    });
  });

  it("rejects root-agent coexistence", async () => {
    const root = await createCollection();
    await mkdir(join(root, "agent"));
    await expect(resolveAgentCollection(root)).rejects.toThrow(/both root agent\/ and agents\//);
  });

  it("rejects flat children", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-collection-flat-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ eve: { collection: true }, private: true }),
    );
    await mkdir(join(root, "agents", "support"), { recursive: true });
    await writeFile(join(root, "agents", "support", "agent.ts"), "export default {};\n");
    await expect(resolveAgentCollection(root)).rejects.toThrow(/Move flat authored files/);
  });

  it("rejects child packages", async () => {
    const root = await createCollection();
    await writeFile(join(root, "agents", "support", "package.json"), "{}\n");
    await expect(resolveAgentCollection(root)).rejects.toThrow(/package.json.*not supported/);
  });

  it("keeps nested named agents discoverable without child package files", async () => {
    const root = await createCollection();
    await expect(resolveDiscoveryProject(join(root, "agents", "support"))).resolves.toEqual({
      agentRoot: join(root, "agents", "support", "agent"),
      appRoot: join(root, "agents", "support"),
      layout: "nested",
    });
  });

  it("does not treat an undeclared agents/<name> path as a marker-free project", async () => {
    const source = createMemoryProjectSource({
      files: {
        "/memory/project/agents/support/agent/instructions.md": "Support users.",
      },
    });

    await expect(
      resolveDiscoveryProject("/memory/project/agents/support", { source }),
    ).rejects.toThrow(/Could not resolve an eve agent root/);
  });

  it("uses the same collection semantics through an in-memory project source", async () => {
    const root = join(process.cwd(), "memory", "project");
    const supportRoot = join(root, "agents", "support");
    const source = createMemoryProjectSource({
      files: {
        [join(root, "package.json")]: '{"eve":{"collection":true}}',
        [join(supportRoot, "agent", "instructions.md")]: "Support users.",
      },
    });

    await expect(resolveDiscoveryProject(supportRoot, { source })).resolves.toEqual({
      agentRoot: join(supportRoot, "agent"),
      appRoot: supportRoot,
      layout: "nested",
    });
  });

  it("does not infer a collection from an undeclared agents directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-undeclared-agents-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
    const supportRoot = join(root, "agents", "support");
    await mkdir(join(supportRoot, "agent"), { recursive: true });

    await expect(resolveEveProjectContext(root)).resolves.toEqual({
      appRoot: root,
      environmentRoots: [root],
      kind: "standalone",
    });
    await expect(resolveEveProjectContext(supportRoot)).resolves.toEqual({
      appRoot: supportRoot,
      environmentRoots: [supportRoot],
      kind: "standalone",
    });
    await expect(resolveDiscoveryProject(supportRoot)).rejects.toThrow(
      /Could not resolve an eve agent root/,
    );
  });

  it("resolves the collection that owns a package-less child", async () => {
    const root = await createCollection();
    const supportRoot = join(root, "agents", "support");
    await expect(resolveEveProjectContext(supportRoot)).resolves.toMatchObject({
      collection: { root },
      environmentRoots: [root, supportRoot],
      kind: "collection-member",
      member: { appRoot: supportRoot, name: "support" },
    });
  });
});
