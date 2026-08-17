import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryProjectSource } from "#discover/project-source.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { resolveAgentWorkspace } from "#internal/agent-workspace.js";
import { resolveEveProjectContext } from "#internal/project-context.js";

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-workspace-"));
  await Promise.all([
    mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
    mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
  ]);
  return root;
}

describe("resolveAgentWorkspace", () => {
  it("discovers direct agents/ children in deterministic order", async () => {
    const root = await createWorkspace();
    await expect(resolveAgentWorkspace(root)).resolves.toEqual({
      members: [
        { name: "research", appRoot: join(root, "agents", "research") },
        { name: "support", appRoot: join(root, "agents", "support") },
      ],
      root,
    });
  });

  it("does not read package.json metadata to discover a workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-workspace-metadata-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ eve: { agents: ["products/*"] }, private: true }),
    );
    await mkdir(join(root, "products", "support", "agent"), { recursive: true });
    await expect(resolveAgentWorkspace(root)).resolves.toBeUndefined();
  });

  it("rejects agent/ and agents/ at the same root", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "agent"));
    await expect(resolveAgentWorkspace(root)).rejects.toThrow(/both agent\/ and agents\//);
  });

  it("rejects empty workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-workspace-empty-"));
    await mkdir(join(root, "agents"));
    await expect(resolveAgentWorkspace(root)).rejects.toThrow(/at least one directory/);
  });

  it("rejects children without a nested agent directory", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "agents", "not-an-agent"));
    await expect(resolveAgentWorkspace(root)).rejects.toThrow(
      /expected agents\/not-an-agent\/agent/,
    );
  });

  it("rejects flat members with a migration hint", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-workspace-flat-"));
    await mkdir(join(root, "agents", "support"), { recursive: true });
    await writeFile(join(root, "agents", "support", "agent.ts"), "export default {};\n");
    await expect(resolveAgentWorkspace(root)).rejects.toThrow(/Move flat authored files/);
  });

  it("keeps conventional members discoverable without project metadata", async () => {
    const root = await createWorkspace();
    const supportRoot = join(root, "agents", "support");
    await expect(resolveDiscoveryProject(supportRoot)).resolves.toEqual({
      agentRoot: join(supportRoot, "agent"),
      appRoot: supportRoot,
      layout: "nested",
    });
  });

  it("supports conventional discovery through an in-memory project source", async () => {
    const root = join(process.cwd(), "memory", "project");
    const supportRoot = join(root, "agents", "support");
    const source = createMemoryProjectSource({
      files: {
        [join(supportRoot, "agent", "instructions.md")]: "Support users.",
      },
    });

    await expect(resolveDiscoveryProject(supportRoot, { source })).resolves.toEqual({
      agentRoot: join(supportRoot, "agent"),
      appRoot: supportRoot,
      layout: "nested",
    });
  });

  it("resolves a workspace member from its application root", async () => {
    const root = await createWorkspace();
    const supportRoot = join(root, "agents", "support");
    await expect(resolveEveProjectContext(supportRoot)).resolves.toMatchObject({
      workspace: { root },
      environmentRoot: root,
      kind: "workspace-member",
      member: { appRoot: supportRoot, name: "support" },
    });
  });
});
