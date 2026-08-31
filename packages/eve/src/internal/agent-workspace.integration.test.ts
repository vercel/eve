import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryProjectSource } from "#discover/project-source.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { resolveAgentWorkspace } from "#internal/agent-workspace.js";
import { resolveEveProjectContext } from "#internal/project-context.js";

async function createWorkspace(agentPatterns: readonly string[] = ["agents/*"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-workspace-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ eve: { agents: agentPatterns }, private: true }),
  );
  await Promise.all([
    mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
    mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
  ]);
  return root;
}

describe("resolveAgentWorkspace", () => {
  it("discovers globbed members in deterministic order", async () => {
    const root = await createWorkspace();
    await expect(resolveAgentWorkspace(root)).resolves.toMatchObject({
      members: [
        { name: "research", appRoot: join(root, "agents", "research") },
        { name: "support", appRoot: join(root, "agents", "support") },
      ],
      root,
    });
  });

  it("discovers exact paths and glob patterns outside agents/", async () => {
    const root = await createWorkspace(["agents/support", "products/*/agent-app"]);
    await mkdir(join(root, "products", "billing", "agent-app", "agent"), { recursive: true });
    await mkdir(join(root, "products", "ignored", "not-an-agent"), { recursive: true });

    await expect(resolveAgentWorkspace(root)).resolves.toMatchObject({
      members: [
        { name: "support", appRoot: join(root, "agents", "support") },
        { name: "agent-app", appRoot: join(root, "products", "billing", "agent-app") },
      ],
    });
  });

  it("supports recursive glob patterns", async () => {
    const root = await createWorkspace(["products/**/agent-app"]);
    await mkdir(join(root, "products", "billing", "agent-app", "agent"), { recursive: true });
    await mkdir(join(root, "products", "support", "specialists", "agent-app", "agent"), {
      recursive: true,
    });

    await expect(resolveAgentWorkspace(root)).rejects.toThrow(
      /multiple agent directories named "agent-app"/,
    );
  });

  it("rejects root-agent coexistence", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "agent"));
    await expect(resolveAgentWorkspace(root)).rejects.toThrow(
      /root agent\/ and declared eve\.agents/,
    );
  });

  it("rejects members without a nested agent directory", async () => {
    const root = await createWorkspace(["agents/*"]);
    await mkdir(join(root, "agents", "not-an-agent"));
    await expect(resolveAgentWorkspace(root)).rejects.toThrow(
      /expected agents\/not-an-agent\/agent/,
    );
  });

  it("rejects flat members with a migration hint", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-workspace-flat-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ eve: { agents: ["agents/support"] }, private: true }),
    );
    await mkdir(join(root, "agents", "support"), { recursive: true });
    await writeFile(join(root, "agents", "support", "agent.ts"), "export default {};\n");
    await expect(resolveAgentWorkspace(root)).rejects.toThrow(/Move flat authored files/);
  });

  it.each([
    ["empty", []],
    ["absolute", ["/agents/support"]],
    ["parent traversal", ["../agents/support"]],
    ["unsupported glob syntax", ["agents/{support,research}"]],
  ])("rejects %s workspace declarations", async (_description, agentPatterns) => {
    const root = await createWorkspace(agentPatterns);
    await expect(resolveAgentWorkspace(root)).rejects.toThrow(/eve\.agents/);
  });

  it("rejects duplicate names resolved from different paths", async () => {
    const root = await createWorkspace(["teams/a/support", "teams/b/support"]);
    await Promise.all([
      mkdir(join(root, "teams", "a", "support", "agent"), { recursive: true }),
      mkdir(join(root, "teams", "b", "support", "agent"), { recursive: true }),
    ]);

    await expect(resolveAgentWorkspace(root)).rejects.toThrow(
      /multiple agent directories named "support"/,
    );
  });

  it("allows a custom-path member package claimed by the root workspace", async () => {
    const root = await createWorkspace(["products/support"]);
    const supportRoot = join(root, "products", "support");
    const packageJsonPath = join(supportRoot, "package.json");
    await mkdir(join(supportRoot, "agent"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "products/*"\n'),
      writeFile(packageJsonPath, "{}\n"),
    ]);

    await expect(resolveAgentWorkspace(root)).resolves.toMatchObject({
      members: [{ name: "support", packageJsonPath }],
    });
  });

  it("rejects an unclaimed custom-path member package", async () => {
    const root = await createWorkspace(["products/support"]);
    const supportRoot = join(root, "products", "support");
    await mkdir(join(supportRoot, "agent"), { recursive: true });
    await writeFile(join(supportRoot, "package.json"), "{}\n");

    await expect(resolveAgentWorkspace(root)).rejects.toThrow(
      /not a member of the root pnpm workspace/,
    );
  });

  it("does not recognize the retired collection declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-retired-collection-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ eve: { collection: true } }));
    await mkdir(join(root, "agents", "support", "agent"), { recursive: true });

    await expect(resolveAgentWorkspace(root)).resolves.toBeUndefined();
  });

  it("keeps declared nested agents discoverable", async () => {
    const root = await createWorkspace(["products/support"]);
    const supportRoot = join(root, "products", "support");
    await mkdir(join(supportRoot, "agent"), { recursive: true });
    await expect(resolveDiscoveryProject(supportRoot)).resolves.toEqual({
      agentRoot: join(supportRoot, "agent"),
      appRoot: supportRoot,
      layout: "nested",
    });
  });

  it("does not treat an undeclared path as a marker-free project", async () => {
    const source = createMemoryProjectSource({
      files: {
        "/memory/project/products/support/agent/instructions.md": "Support users.",
      },
    });

    await expect(
      resolveDiscoveryProject("/memory/project/products/support", { source }),
    ).rejects.toThrow(/Could not resolve an eve agent root/);
  });

  it("uses custom workspace semantics through an in-memory project source", async () => {
    const root = join(process.cwd(), "memory", "project");
    const supportRoot = join(root, "products", "support");
    const source = createMemoryProjectSource({
      files: {
        [join(root, "package.json")]: '{"eve":{"agents":["products/*"]}}',
        [join(supportRoot, "agent", "instructions.md")]: "Support users.",
      },
    });

    await expect(resolveDiscoveryProject(supportRoot, { source })).resolves.toEqual({
      agentRoot: join(supportRoot, "agent"),
      appRoot: supportRoot,
      layout: "nested",
    });
  });

  it("does not infer a workspace from undeclared directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-undeclared-agents-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
    const supportRoot = join(root, "agents", "support");
    await mkdir(join(supportRoot, "agent"), { recursive: true });

    await expect(resolveEveProjectContext(root)).resolves.toEqual({
      appRoot: root,
      environmentRoot: root,
      kind: "standalone",
    });
    await expect(resolveEveProjectContext(supportRoot)).resolves.toEqual({
      appRoot: supportRoot,
      environmentRoot: supportRoot,
      kind: "standalone",
    });
  });

  it("resolves a custom-path workspace member from its application root", async () => {
    const root = await createWorkspace(["products/support"]);
    const supportRoot = join(root, "products", "support");
    await mkdir(join(supportRoot, "agent"), { recursive: true });
    await expect(resolveEveProjectContext(supportRoot)).resolves.toMatchObject({
      workspace: { root },
      environmentRoot: root,
      kind: "workspace-member",
      member: { appRoot: supportRoot, name: "support" },
    });
  });
});
