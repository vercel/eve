import { afterEach, describe, expect, it, vi } from "vitest";

import { prewarmAppSandboxes, prewarmBundledAppSandboxes } from "#execution/sandbox/prewarm.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import type {
  SandboxBackend,
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
} from "#public/definitions/sandbox-backend.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID, type ResolvedAgentGraphBundle } from "#runtime/graph.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";

const mocks = vi.hoisted(() => ({
  materializeWorkspaceDirectory: vi.fn<
    () => Promise<readonly { readonly content: Buffer; readonly path: string }[]>
  >(async () => []),
  resolveRuntimeAgentGraph: vi.fn(),
}));

vi.mock("#runtime/resolve-agent-graph.js", () => ({
  resolveRuntimeAgentGraph: mocks.resolveRuntimeAgentGraph,
}));

vi.mock("#execution/sandbox/template-prewarm-lock.js", () => ({
  withSandboxTemplatePrewarmLock: async (_input: unknown, callback: () => Promise<unknown>) =>
    await callback(),
}));
vi.mock("#runtime/workspace/seed-files.js", () => ({
  materializeWorkspaceDirectory: mocks.materializeWorkspaceDirectory,
}));

describe("prewarmAppSandboxes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.materializeWorkspaceDirectory.mockReset();
    mocks.materializeWorkspaceDirectory.mockResolvedValue([]);
    mocks.resolveRuntimeAgentGraph.mockReset();
  });

  it("uses the stable sandbox app root for dev snapshot artifact sources", async () => {
    const appRoot = process.cwd();
    const firstSnapshotRoot = `${appRoot}/.eve/dev-runtime/snapshots/one/app`;
    const secondSnapshotRoot = `${appRoot}/.eve/dev-runtime/snapshots/two/app`;
    const firstInputs: SandboxBackendPrewarmInput[] = [];
    const secondInputs: SandboxBackendPrewarmInput[] = [];
    const workspaceResourceRoot = {
      contentHash: "workspace-content-hash",
      logicalPath: "empty-resource-root",
      rootEntries: [],
    };

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(firstSnapshotRoot, {
        moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
        sandboxAppRoot: appRoot,
      }),
      dispatch: recordPrewarmInputs(firstInputs),
      loadAgentGraph: async () => createGraph({ workspaceResourceRoot }),
    });
    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(secondSnapshotRoot, {
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

  it("hydrates bundled workspace resources without deployed source files", async () => {
    const workspaceResourceRoot = {
      contentHash: "workspace-content-hash",
      logicalPath: "workspace-resources/__root__",
      rootEntries: ["fixture.txt"],
    };
    const graph = createGraph({ workspaceResourceRoot });
    mocks.resolveRuntimeAgentGraph.mockResolvedValueOnce(graph);
    mocks.materializeWorkspaceDirectory.mockResolvedValueOnce([
      { content: Buffer.from("portable bytes"), path: "/workspace/fixture.txt" },
    ]);
    const inputs: SandboxBackendPrewarmInput[] = [];
    const manifest = {
      ...createCompiledAgentManifest({
        agentRoot: "/deleted/agent",
        appRoot: "/deleted/app",
        config: {
          model: {
            id: "openai/gpt-5-mini",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "portable-agent",
        },
      }),
      workspaceResourceRoot,
    };

    await withBundledCompiledArtifacts(
      {
        manifest,
        moduleMap: { nodes: {} },
        compilerArtifactsRoot: "/moved/output/.eve",
      },
      async () => {
        await prewarmBundledAppSandboxes({
          appRoot: "/moved/output",
          dispatch: recordPrewarmInputs(inputs),
        });
      },
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.seedFiles).toEqual([
      {
        content: Buffer.from("portable bytes"),
        path: "/workspace/fixture.txt",
      },
    ]);
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
