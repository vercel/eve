import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryProjectSource } from "#discover/project-source.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { findEveProjectContext, resolveEveProjectContext } from "#internal/project-context.js";

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-workspace-"));
  await Promise.all([
    mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
    mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
    writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } })),
  ]);
  return root;
}

describe("resolveEveProjectContext", () => {
  it("discovers direct agents/ children in deterministic order", async () => {
    const root = await createWorkspace();
    await expect(resolveEveProjectContext(root)).resolves.toEqual({
      environmentRoot: root,
      kind: "workspace",
      workspace: {
        members: [
          { name: "research", appRoot: join(root, "agents", "research") },
          { name: "support", appRoot: join(root, "agents", "support") },
        ],
        root,
      },
    });
  });

  it("requires the root package to declare eve as a runtime dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-workspace-no-dependency-"));
    await Promise.all([
      mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
      writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { eve: "*" } })),
    ]);
    await expect(findEveProjectContext(root)).resolves.toBeUndefined();
  });

  it("treats agents in a monorepo that only develops with eve as standalone projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-agent-monorepo-"));
    const appRoot = join(root, "agents", "support");
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { eve: "*" } })),
      writeFile(
        join(appRoot, "package.json"),
        JSON.stringify({ dependencies: { eve: "*" }, name: "support" }),
      ),
    ]);

    await expect(resolveEveProjectContext(join(appRoot, "agent"))).resolves.toEqual({
      appRoot,
      environmentRoot: appRoot,
      kind: "standalone",
    });
  });

  it("treats agent/ as standalone even when agents/ also exists", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "agent"));

    await expect(resolveEveProjectContext(root)).resolves.toEqual({
      appRoot: root,
      environmentRoot: root,
      kind: "standalone",
    });
  });

  it("allows an empty workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-workspace-empty-"));
    await mkdir(join(root, "agents"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } }));

    await expect(resolveEveProjectContext(root)).resolves.toMatchObject({
      kind: "workspace",
      workspace: { members: [], root },
    });
  });

  it("discovers flat workspace members", async () => {
    const root = await createWorkspace();
    const appRoot = join(root, "agents", "flat");
    await mkdir(appRoot);
    await writeFile(join(appRoot, "agent.ts"), "export default {};\n");

    await expect(resolveEveProjectContext(appRoot)).resolves.toMatchObject({
      kind: "workspace-member",
      member: { appRoot, name: "flat" },
    });
  });

  it("excludes independently packaged eve projects from a workspace", async () => {
    const root = await createWorkspace();
    const appRoot = join(root, "agents", "billing");
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify({ dependencies: { eve: "*" }, name: "billing" }),
    );

    await expect(resolveEveProjectContext(root)).resolves.toMatchObject({
      kind: "workspace",
      workspace: {
        members: [
          { name: "research", appRoot: join(root, "agents", "research") },
          { name: "support", appRoot: join(root, "agents", "support") },
        ],
      },
    });
    await expect(resolveEveProjectContext(appRoot)).resolves.toEqual({
      appRoot,
      environmentRoot: appRoot,
      kind: "standalone",
    });
  });

  it("excludes packaged non-eve directories from a workspace", async () => {
    const root = await createWorkspace();
    const appRoot = join(root, "agents", "utilities");
    await mkdir(join(appRoot, "src"), { recursive: true });
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "utilities" }));

    await expect(resolveEveProjectContext(root)).resolves.toMatchObject({
      kind: "workspace",
      workspace: {
        members: [
          { name: "research", appRoot: join(root, "agents", "research") },
          { name: "support", appRoot: join(root, "agents", "support") },
        ],
      },
    });
    await expect(findEveProjectContext(appRoot)).resolves.toBeUndefined();
  });

  it("excludes package-less directories without agent files from a workspace", async () => {
    const root = await createWorkspace();
    const sharedRoot = join(root, "agents", "Internal Helpers");
    await mkdir(sharedRoot);
    await writeFile(join(sharedRoot, "helpers.ts"), "export {};\n");

    await expect(resolveEveProjectContext(root)).resolves.toMatchObject({
      kind: "workspace",
      workspace: {
        members: [
          { name: "research", appRoot: join(root, "agents", "research") },
          { name: "support", appRoot: join(root, "agents", "support") },
        ],
      },
    });
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
        [join(root, "package.json")]: JSON.stringify({ dependencies: { eve: "*" } }),
        [join(supportRoot, "agent", "instructions.md")]: "Support users.",
      },
    });

    await expect(resolveDiscoveryProject(supportRoot, { source })).resolves.toEqual({
      agentRoot: join(supportRoot, "agent"),
      appRoot: supportRoot,
      layout: "nested",
    });
  });

  it("resolves a workspace member from any file in its tree", async () => {
    const root = await createWorkspace();
    const supportRoot = join(root, "agents", "support");
    const toolPath = join(supportRoot, "agent", "tools", "search.ts");
    await mkdir(join(supportRoot, "agent", "tools"), { recursive: true });
    await writeFile(toolPath, "export default {};\n");
    await expect(resolveEveProjectContext(toolPath)).resolves.toMatchObject({
      workspace: { root },
      environmentRoot: root,
      kind: "workspace-member",
      member: { appRoot: supportRoot, name: "support" },
    });
  });

  it("ignores unrelated agents directories above a standalone project", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-standalone-unrelated-agents-"));
    const appRoot = join(root, "eve", "apps", "fixtures", "weather-agent");
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await mkdir(join(root, "agents", "apps"), { recursive: true });
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ dependencies: { eve: "*" } }));

    await expect(resolveEveProjectContext(appRoot)).resolves.toEqual({
      appRoot,
      environmentRoot: appRoot,
      kind: "standalone",
    });
  });

  it("preserves a standalone project boundary above an agents directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-standalone-boundary-"));
    const appRoot = join(root, "agents", "support");
    await mkdir(join(root, "agent"), { recursive: true });
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } }));
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ dependencies: { eve: "*" } }));

    await expect(resolveEveProjectContext(appRoot)).resolves.toEqual({
      appRoot,
      environmentRoot: appRoot,
      kind: "standalone",
    });
  });

  it("resolves a flat standalone agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-flat-agent-"));
    await Promise.all([
      writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } })),
      writeFile(join(root, "agent.ts"), "export default {};\n"),
    ]);

    await expect(resolveEveProjectContext(root)).resolves.toEqual({
      appRoot: root,
      environmentRoot: root,
      kind: "standalone",
    });
  });

  it("keeps a flat standalone agent above an unrelated agents directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-flat-agent-unrelated-agents-"));
    await mkdir(join(root, "agents", "customer-support"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } })),
      writeFile(join(root, "agent.ts"), "export default {};\n"),
      writeFile(join(root, "agents", "customer-support", "index.ts"), "export {};\n"),
    ]);

    await expect(resolveEveProjectContext(root)).resolves.toEqual({
      appRoot: root,
      environmentRoot: root,
      kind: "standalone",
    });
  });

  it("resolves workspace-owned paths outside any member to the workspace", async () => {
    const root = await createWorkspace();
    const sourceRoot = join(root, "src");
    await mkdir(sourceRoot);

    await expect(resolveEveProjectContext(sourceRoot)).resolves.toMatchObject({
      workspace: { root },
      environmentRoot: root,
      kind: "workspace",
    });
  });

  it("stops at the nearest non-eve package boundary", async () => {
    const root = await createWorkspace();
    const packageRoot = join(root, "packages", "unrelated");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ dependencies: {} }));

    await expect(findEveProjectContext(packageRoot)).resolves.toBeUndefined();
  });

  it("rejects an eve package without agent files", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-invalid-shape-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } }));

    await expect(resolveEveProjectContext(root)).rejects.toThrow(/found no agent files/);
  });
});
