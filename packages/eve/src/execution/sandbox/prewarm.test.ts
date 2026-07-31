import { beforeEach, describe, expect, it, vi } from "vitest";

import { prewarmSandboxes } from "#execution/sandbox/prewarm.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID, type ResolvedAgentGraphBundle } from "#runtime/graph.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import type { SandboxSeedFile } from "#execution/sandbox/bindings/local-workspace-utils.js";
import { defineSandboxTemplate } from "#shared/sandbox-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";

const mocks = vi.hoisted(() => ({
  materializeWorkspaceDirectory: vi.fn<() => Promise<SandboxSeedFile[]>>(async () => []),
}));

vi.mock("#execution/sandbox/template-prewarm-lock.js", () => ({
  withSandboxTemplatePrewarmLock: async (_input: unknown, callback: () => Promise<unknown>) =>
    await callback(),
}));
vi.mock("#runtime/workspace/seed-files.js", () => ({
  materializeWorkspaceDirectory: mocks.materializeWorkspaceDirectory,
}));

describe("prewarmSandboxes", () => {
  beforeEach(() => {
    mocks.materializeWorkspaceDirectory.mockReset();
    mocks.materializeWorkspaceDirectory.mockResolvedValue([]);
  });

  it("prewarms exported templates without invoking the sandbox definition", async () => {
    const definition = vi.fn();
    const prewarm = vi.fn(async () => ({ snapshotId: "snapshot_123" }));
    const template = defineSandboxTemplate({
      type: "test.dev/prewarm-template/v1",
      prewarm,
      async create() {
        throw new Error("runtime create must not run during prewarm");
      },
    });

    const bindings = await prewarmSandboxes({
      appRoot: process.cwd(),
      compileDirectoryPath: "/tmp/eve-compile",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      graph: createGraph({
        definition,
        templates: [{ exportName: "template", template }],
      }),
    });

    expect(definition).not.toHaveBeenCalled();
    expect(prewarm).toHaveBeenCalledOnce();
    expect(bindings).toEqual([
      {
        exportName: "template",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
        reference: { snapshotId: "snapshot_123" },
        templateKey: expect.any(String),
      },
    ]);
  });

  it("hydrates the managed workspace through the provider template", async () => {
    mocks.materializeWorkspaceDirectory.mockResolvedValue([
      { content: "workspace contents", path: "README.md" },
    ]);
    const sandbox = mockSandbox();
    const template = defineSandboxTemplate({
      type: "test.dev/hydration-template/v1",
      async prewarm({ hydrate }) {
        await hydrate(sandbox.session as Sandbox);
        return { image: "template-image" };
      },
      async create() {
        throw new Error("runtime create must not run during prewarm");
      },
    });

    await prewarmSandboxes({
      appRoot: process.cwd(),
      compileDirectoryPath: "/tmp/eve-compile",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      graph: createGraph({
        templates: [{ exportName: "template", template }],
        workspaceResourceRoot: {
          contentHash: "workspace-hash",
          logicalPath: "workspace",
          rootEntries: ["README.md"],
        },
      }),
    });

    expect(sandbox.files.get("/workspace/README.md")).toBe("workspace contents");
  });

  it("prewarms every exported template with a distinct private key", async () => {
    const first = defineSandboxTemplate({
      type: "test.dev/distinct-template/v1",
      async prewarm() {
        return { snapshotId: "first" };
      },
      async create() {
        throw new Error("runtime only");
      },
    });
    const second = defineSandboxTemplate({
      type: "test.dev/distinct-template/v1",
      async prewarm() {
        return { snapshotId: "second" };
      },
      async create() {
        throw new Error("runtime only");
      },
    });
    const templateKeys: string[] = [];

    const bindings = await prewarmSandboxes({
      appRoot: process.cwd(),
      compileDirectoryPath: "/tmp/eve-compile",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      dispatch: async ({ prewarm, templateKey }) => {
        templateKeys.push(templateKey);
        return await prewarm();
      },
      graph: createGraph({
        templates: [
          { exportName: "first", template: first },
          { exportName: "second", template: second },
        ],
      }),
    });

    expect(new Set(templateKeys)).toHaveLength(2);
    expect(bindings.map(({ exportName }) => exportName)).toEqual(["first", "second"]);
  });

  it("reuses bindings for a graph whose prewarm signature is already warm", async () => {
    const prewarm = vi.fn(async () => ({ snapshotId: "unused" }));
    const reused = [
      {
        exportName: "template",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
        reference: { snapshotId: "existing" },
        templateKey: "existing-template-key",
      },
    ] as const;
    const reusePrewarmSignature = vi.fn(() => reused);
    const template = defineSandboxTemplate({
      type: "test.dev/signature-template/v1",
      prewarm,
      async create() {
        throw new Error("runtime only");
      },
    });

    const bindings = await prewarmSandboxes({
      appRoot: process.cwd(),
      compileDirectoryPath: "/tmp/eve-compile",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      graph: createGraph({
        templates: [{ exportName: "template", template }],
      }),
      reusePrewarmSignature,
    });

    expect(bindings).toEqual(reused);
    expect(reusePrewarmSignature).toHaveBeenCalledOnce();
    expect(prewarm).not.toHaveBeenCalled();
  });

  it("requires an exported template when an authored sandbox owns workspace files", async () => {
    mocks.materializeWorkspaceDirectory.mockResolvedValue([
      { content: "workspace contents", path: "README.md" },
    ]);

    await expect(
      prewarmSandboxes({
        appRoot: process.cwd(),
        compileDirectoryPath: "/tmp/eve-compile",
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        graph: createGraph({
          templates: [],
          workspaceResourceRoot: {
            contentHash: "workspace-hash",
            logicalPath: "workspace",
            rootEntries: ["README.md"],
          },
        }),
      }),
    ).rejects.toThrow(/exports no SandboxTemplate/);
  });
});

function createGraph(input: {
  readonly definition?: ResolvedSandboxDefinition["definition"];
  readonly templates: ResolvedSandboxDefinition["templates"];
  readonly workspaceResourceRoot?: {
    readonly contentHash?: string;
    readonly logicalPath: string;
    readonly rootEntries: readonly string[];
  };
}): ResolvedAgentGraphBundle {
  const definition: ResolvedSandboxDefinition = {
    definition:
      input.definition ??
      (() => {
        throw new Error("sandbox definition must not run during prewarm");
      }),
    logicalPath: "agent/sandbox/sandbox.ts",
    sourceHash: "sandbox-source-hash",
    sourceId: "agent/sandbox/sandbox",
    sourceKind: "module",
    templates: input.templates,
  };
  const root = {
    nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
    sandboxRegistry: {
      sandbox: {
        definition,
        workspaceResourceRoot: input.workspaceResourceRoot ?? {
          logicalPath: "",
          rootEntries: [],
        },
      },
    },
  };

  return {
    nodesByNodeId: new Map([[ROOT_RUNTIME_AGENT_NODE_ID, root as never]]),
    root: root as never,
  };
}
