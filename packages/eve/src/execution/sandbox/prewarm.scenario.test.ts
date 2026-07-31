import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();
const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("sandbox template prewarm", () => {
  it("discovers named templates without invoking the session definition", async () => {
    const appRoot = await createApp({
      rootSandbox: sandboxModule("root-snapshot"),
      subagentSandbox: sandboxModule("child-snapshot"),
      withWorkspace: true,
    });
    const templateKeys: string[] = [];

    await compileAgent({ startPath: appRoot });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: async ({ prewarm, templateKey }) => {
        templateKeys.push(templateKey);
        return await prewarm();
      },
    });

    expect(new Set(templateKeys).size).toBe(2);
    const manifest = JSON.parse(
      await readFile(join(appRoot, ".eve", "compile", "compiled-agent-manifest.json"), "utf8"),
    ) as {
      sandboxTemplateReferences: Record<string, unknown>;
      subagents: Array<{
        agent: { sandboxTemplateReferences: Record<string, unknown> };
      }>;
    };
    expect(manifest.sandboxTemplateReferences).toEqual({
      template: { snapshotId: "root-snapshot" },
    });
    expect(manifest.subagents[0]?.agent.sandboxTemplateReferences).toEqual({
      template: { snapshotId: "child-snapshot" },
    });
  });

  it("persists the synthesized default template binding without an authored sandbox", async () => {
    const appRoot = await createApp({ withWorkspace: true });

    await compileAgent({ startPath: appRoot });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: async () => ({
        provider: "just-bash",
        reference: { snapshotId: "default-snapshot" },
      }),
    });

    const manifest = JSON.parse(
      await readFile(join(appRoot, ".eve", "compile", "compiled-agent-manifest.json"), "utf8"),
    ) as {
      sandbox: unknown;
      sandboxTemplateReferences: Record<string, unknown>;
    };
    expect(manifest.sandbox).toBeNull();
    expect(manifest.sandboxTemplateReferences).toEqual({
      template: {
        provider: "just-bash",
        reference: { snapshotId: "default-snapshot" },
      },
    });
  });

  it("fails when managed workspace files have no exported template", async () => {
    const appRoot = await createApp({
      rootSandbox: [
        'import { defineSandbox } from "eve/sandbox";',
        "export default defineSandbox(() => {",
        '  throw new Error("runtime definition must not run during build");',
        "});",
        "",
      ].join("\n"),
      withWorkspace: true,
    });

    await compileAgent({ startPath: appRoot });

    await expect(prewarmAppSandboxes({ appRoot })).rejects.toThrow(
      /has a managed workspace but exports no SandboxTemplate/,
    );
  });

  it("changes the private template identity when workspace contents change", async () => {
    const firstRoot = await createApp({
      rootSandbox: sandboxModule("snapshot"),
      withWorkspace: true,
      workspaceContents: "first",
    });
    const secondRoot = await createApp({
      rootSandbox: sandboxModule("snapshot"),
      withWorkspace: true,
      workspaceContents: "second",
    });
    const firstKeys: string[] = [];
    const secondKeys: string[] = [];

    await compileAgent({ startPath: firstRoot });
    await prewarmAppSandboxes({
      appRoot: firstRoot,
      dispatch: async ({ prewarm, templateKey }) => {
        firstKeys.push(templateKey);
        return await prewarm();
      },
    });
    await compileAgent({ startPath: secondRoot });
    await prewarmAppSandboxes({
      appRoot: secondRoot,
      dispatch: async ({ prewarm, templateKey }) => {
        secondKeys.push(templateKey);
        return await prewarm();
      },
    });

    expect(firstKeys).toHaveLength(1);
    expect(secondKeys).toHaveLength(1);
    expect(firstKeys[0]).not.toBe(secondKeys[0]);
  });
});

function sandboxModule(snapshotId: string): string {
  return [
    'import { defineSandbox } from "eve/sandbox";',
    'import { defineSandboxTemplate } from "eve/sandbox/provider";',
    "export const template = defineSandboxTemplate({",
    '  type: "test.dev/scenario-template/v1",',
    "  async prewarm() {",
    `    return { snapshotId: ${JSON.stringify(snapshotId)} };`,
    "  },",
    "  async create() {",
    '    throw new Error("runtime template create must not run during build");',
    "  },",
    "});",
    "export default defineSandbox(() => {",
    '  throw new Error("runtime definition must not run during build");',
    "});",
    "",
  ].join("\n");
}

async function createApp(input: {
  readonly rootSandbox?: string;
  readonly subagentSandbox?: string;
  readonly withWorkspace?: boolean;
  readonly workspaceContents?: string;
}): Promise<string> {
  const appRoot = await createScratchDirectory("eve-sandbox-prewarm-");
  const agentRoot = join(appRoot, "agent");
  await mkdir(join(agentRoot, "sandbox"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await symlink(EVE_PACKAGE_ROOT, join(appRoot, "node_modules", "eve"), "dir");
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify({ name: "sandbox-prewarm-scenario", type: "module" }),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root instructions.\n");
  if (input.rootSandbox !== undefined) {
    await writeFile(join(agentRoot, "sandbox", "sandbox.ts"), input.rootSandbox);
  }

  if (input.withWorkspace) {
    await mkdir(join(agentRoot, "sandbox", "workspace"), { recursive: true });
    await writeFile(
      join(agentRoot, "sandbox", "workspace", "README.md"),
      input.workspaceContents ?? "workspace",
    );
  }

  if (input.subagentSandbox !== undefined) {
    const subagentRoot = join(agentRoot, "subagents", "reviewer");
    await mkdir(join(subagentRoot, "sandbox"), { recursive: true });
    await writeFile(
      join(subagentRoot, "agent.ts"),
      [
        "export default {",
        '  description: "Reviews work",',
        '  model: "openai/gpt-5.4",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(subagentRoot, "instructions.md"), "Review carefully.\n");
    await writeFile(join(subagentRoot, "sandbox", "sandbox.ts"), input.subagentSandbox);
  }

  return appRoot;
}
