import { afterEach, describe, expect, it, vi } from "vitest";

import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import type {
  SandboxBackend,
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
} from "#public/definitions/sandbox-backend.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID, type ResolvedAgentGraphBundle } from "#runtime/graph.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { hashWorkspaceResourceFiles } from "#shared/workspace-resource-identity.js";

vi.mock("#execution/sandbox/template-prewarm-lock.js", () => ({
  withSandboxTemplatePrewarmLock: async (_input: unknown, callback: () => Promise<unknown>) =>
    await callback(),
}));
const mocks = vi.hoisted(() => ({
  inspectWorkspaceResourceRoot: vi.fn(
    async (): Promise<{
      readonly contentHash?: string;
      readonly rootEntries: readonly string[];
    }> => ({ rootEntries: [] }),
  ),
  materializeWorkspaceDirectory: vi.fn<
    (path: string) => Promise<readonly { readonly content: Buffer; readonly path: string }[]>
  >(async () => []),
}));

vi.mock("#shared/workspace-resource-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#shared/workspace-resource-identity.js")>()),
  inspectWorkspaceResourceRoot: mocks.inspectWorkspaceResourceRoot,
}));
vi.mock("#runtime/workspace/seed-files.js", () => ({
  materializeWorkspaceDirectory: mocks.materializeWorkspaceDirectory,
}));
vi.mock("#runtime/loaders/compile-metadata.js", () => ({
  loadCompileMetadata: vi.fn(async () => ({
    generator: { version: "0.0.0-test" },
  })),
}));

describe("prewarmAppSandboxes", () => {
  afterEach(() => {
    mocks.inspectWorkspaceResourceRoot.mockReset();
    mocks.inspectWorkspaceResourceRoot.mockResolvedValue({ rootEntries: [] });
    mocks.materializeWorkspaceDirectory.mockReset();
    mocks.materializeWorkspaceDirectory.mockResolvedValue([]);
    vi.unstubAllEnvs();
  });

  it("uses the stable sandbox app root for dev snapshot artifact sources", async () => {
    const appRoot = process.cwd();
    const firstSnapshotRoot = `${appRoot}/.eve/dev-runtime/snapshots/one/app`;
    const secondSnapshotRoot = `${appRoot}/.eve/dev-runtime/snapshots/two/app`;
    const firstInputs: SandboxBackendPrewarmInput[] = [];
    const secondInputs: SandboxBackendPrewarmInput[] = [];
    const workspaceResourceRoot = {
      logicalPath: "workspace-resources/__root__",
      rootEntries: [],
    };

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(firstSnapshotRoot, {
        moduleMapLoaderKind: "materialized-generation",
        moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
        sandboxAppRoot: appRoot,
      }),
      dispatch: recordPrewarmInputs(firstInputs),
      loadAgentGraph: async () => createGraph({ workspaceResourceRoot }),
    });
    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(secondSnapshotRoot, {
        moduleMapLoaderKind: "materialized-generation",
        moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
        sandboxAppRoot: appRoot,
      }),
      dispatch: recordPrewarmInputs(secondInputs),
      loadAgentGraph: async () => createGraph({ workspaceResourceRoot }),
    });

    expect(firstInputs).toHaveLength(1);
    expect(secondInputs).toHaveLength(1);
    expect(firstInputs[0]?.runtimeContext.appRoot).toBe(appRoot);
    expect(secondInputs[0]?.runtimeContext.appRoot).toBe(appRoot);
    expect(firstInputs[0]?.templateKey).toBe(secondInputs[0]?.templateKey);
  });

  it("rejects a workspace resource path that is not canonical for its node", async () => {
    await expect(
      prewarmAppSandboxes({
        appRoot: process.cwd(),
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(process.cwd()),
        dispatch: recordPrewarmInputs([]),
        loadAgentGraph: async () =>
          createGraph({
            workspaceResourceRoot: {
              contentHash: "0".repeat(64),
              logicalPath: "../outside",
              rootEntries: ["seed.txt"],
            },
          }),
      }),
    ).rejects.toThrow(/does not match canonical path/u);
    expect(mocks.inspectWorkspaceResourceRoot).not.toHaveBeenCalled();
  });

  it("rejects materialized workspace bytes that do not match the compiled identity", async () => {
    mocks.inspectWorkspaceResourceRoot.mockResolvedValue({
      contentHash: "1".repeat(64),
      rootEntries: ["seed.txt"],
    });

    await expect(
      prewarmAppSandboxes({
        appRoot: process.cwd(),
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(process.cwd()),
        dispatch: recordPrewarmInputs([]),
        loadAgentGraph: async () =>
          createGraph({
            workspaceResourceRoot: {
              contentHash: "0".repeat(64),
              logicalPath: "workspace-resources/__root__",
              rootEntries: ["seed.txt"],
            },
          }),
      }),
    ).rejects.toThrow(/bytes do not match contentHash/u);
  });

  it("rejects workspace entries that do not match the materialized tree", async () => {
    mocks.inspectWorkspaceResourceRoot.mockResolvedValue({
      contentHash: "0".repeat(64),
      rootEntries: ["other.txt"],
    });

    await expect(
      prewarmAppSandboxes({
        appRoot: process.cwd(),
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(process.cwd()),
        dispatch: recordPrewarmInputs([]),
        loadAgentGraph: async () =>
          createGraph({
            workspaceResourceRoot: {
              contentHash: "0".repeat(64),
              logicalPath: "workspace-resources/__root__",
              rootEntries: ["seed.txt"],
            },
          }),
      }),
    ).rejects.toThrow(/entries do not match the materialized tree/u);
  });

  it("rejects workspace bytes that change while preparing the sandbox seed", async () => {
    const expectedContent = Buffer.from("expected");
    const expectedHash = hashWorkspaceResourceFiles([
      { content: expectedContent, logicalPath: "workspace/seed.txt" },
    ])!;
    mocks.inspectWorkspaceResourceRoot.mockResolvedValue({
      contentHash: expectedHash,
      rootEntries: ["seed.txt"],
    });
    mocks.materializeWorkspaceDirectory.mockResolvedValue([
      { content: Buffer.from("changed"), path: `${WORKSPACE_ROOT}/seed.txt` },
    ]);

    await expect(
      prewarmAppSandboxes({
        appRoot: process.cwd(),
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(process.cwd()),
        dispatch: recordPrewarmInputs([]),
        loadAgentGraph: async () =>
          createGraph({
            workspaceResourceRoot: {
              contentHash: expectedHash,
              logicalPath: "workspace-resources/__root__",
              rootEntries: ["seed.txt"],
            },
          }),
      }),
    ).rejects.toThrow(/bytes changed while preparing/u);
  });

  it("passes exact verified workspace bytes to sandbox prewarm", async () => {
    const content = Buffer.from("seed");
    const contentHash = hashWorkspaceResourceFiles([
      { content, logicalPath: "workspace/seed.txt" },
    ])!;
    mocks.inspectWorkspaceResourceRoot.mockResolvedValue({
      contentHash,
      rootEntries: ["seed.txt"],
    });
    mocks.materializeWorkspaceDirectory.mockResolvedValue([
      { content, path: `${WORKSPACE_ROOT}/seed.txt` },
    ]);
    const inputs: SandboxBackendPrewarmInput[] = [];

    await prewarmAppSandboxes({
      appRoot: process.cwd(),
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(process.cwd()),
      dispatch: recordPrewarmInputs(inputs),
      loadAgentGraph: async () =>
        createGraph({
          workspaceResourceRoot: {
            contentHash,
            logicalPath: "workspace-resources/__root__",
            rootEntries: ["seed.txt"],
          },
        }),
    });

    expect(inputs[0]?.seedFiles).toEqual([{ content, path: `${WORKSPACE_ROOT}/seed.txt` }]);
  });

  it("skips backend prewarm when the sandbox signature is already warm", async () => {
    const appRoot = process.cwd();
    const inputs: SandboxBackendPrewarmInput[] = [];
    const signatures: string[] = [];

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      dispatch: recordPrewarmInputs(inputs),
      loadAgentGraph: async () => createGraph(),
      shouldPrewarmSignature: (signature) => {
        signatures.push(signature);
        return false;
      },
    });

    expect(inputs).toHaveLength(0);
    expect(signatures).toHaveLength(1);
  });

  it("prewarms only the owner of an inherited sandbox", async () => {
    const appRoot = process.cwd();
    const inputs: SandboxBackendPrewarmInput[] = [];

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      dispatch: recordPrewarmInputs(inputs),
      loadAgentGraph: async () => createGraphWithInheritedChild(),
    });

    expect(inputs).toHaveLength(1);
  });

  it.each(["docker", "microsandbox"])(
    "explains that %s is unavailable during Vercel prewarm",
    async (backendName) => {
      vi.stubEnv("VERCEL", "1");

      const appRoot = process.cwd();
      const cause = new Error("backend host check failed");
      const log = vi.fn();

      await expect(
        prewarmAppSandboxes({
          appRoot,
          compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
          dispatch: async () => {
            throw cause;
          },
          loadAgentGraph: async () => createGraph({ backendName }),
          log,
        }),
      ).rejects.toMatchObject({
        cause,
        message: expect.stringContaining(
          `The ${backendName} sandbox backend is not available when deploying on Vercel.`,
        ),
      });

      const messages = log.mock.calls.map(([message]) => String(message));
      expect(messages).toEqual([
        "eve: initializing 1 sandbox template...",
        expect.stringContaining(
          `The ${backendName} sandbox backend is not available when deploying on Vercel.`,
        ),
      ]);
      expect(messages[1]).toContain("Use defaultBackend()");
      expect(messages[1]).toContain("Vercel-compatible backend explicitly, such as vercel()");
      expect(messages[1]).toContain("Original");
      expect(messages[1]).toContain(cause.message);
    },
  );
});

function recordPrewarmInputs(inputs: SandboxBackendPrewarmInput[]) {
  return async ({
    input,
  }: {
    backend: SandboxBackend;
    input: SandboxBackendPrewarmInput;
  }): Promise<SandboxBackendPrewarmResult> => {
    inputs.push(input);
    return { reused: true };
  };
}

function createGraph(
  input: {
    readonly backendName?: string;
    readonly workspaceResourceRoot?: {
      readonly contentHash?: string;
      readonly logicalPath: string;
      readonly rootEntries: readonly string[];
    };
  } = {},
): ResolvedAgentGraphBundle {
  const backend: SandboxBackend = {
    async create() {
      throw new Error("Unexpected create call.");
    },
    name: input.backendName ?? "test",
    async prewarm() {
      return { reused: true };
    },
  };
  const definition: ResolvedSandboxDefinition = {
    async bootstrap() {},
    backend,
    logicalPath: "agent/sandbox/sandbox.ts",
    revalidationKey: "stable-bootstrap",
    sourceHash: "sandbox-source-hash",
    sourceId: "agent/sandbox/sandbox",
    sourceKind: "module",
  };
  const root = {
    nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
    sandboxRegistry: {
      sandbox: {
        definition,
        workspaceResourceRoot: input.workspaceResourceRoot ?? {
          logicalPath: "workspace-resources/__root__",
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

function createGraphWithInheritedChild(): ResolvedAgentGraphBundle {
  const graph = createGraph();
  const owner = graph.root.sandboxRegistry.sandbox;
  const child = {
    nodeId: "subagents/research",
    sandboxRegistry: {
      sandbox: {
        definition: {
          ...owner.definition,
          inheritsParent: true,
          logicalPath: "agent/subagents/research/sandbox.ts",
          sourceHash: "child-selector-source-hash",
          sourceId: "agent/subagents/research/sandbox",
        },
        inheritance: {
          definition: owner.definition,
          nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
          workspaceResourceRoot: owner.workspaceResourceRoot,
        },
        workspaceResourceRoot: {
          logicalPath: "workspace-resources/subagents/research",
          rootEntries: [],
        },
      },
    },
  };
  return {
    ...graph,
    nodesByNodeId: new Map([
      [ROOT_RUNTIME_AGENT_NODE_ID, graph.root],
      [child.nodeId, child as never],
    ]),
  };
}
