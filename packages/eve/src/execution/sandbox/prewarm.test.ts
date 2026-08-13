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

vi.mock("#execution/sandbox/template-prewarm-lock.js", () => ({
  withSandboxTemplatePrewarmLock: async (_input: unknown, callback: () => Promise<unknown>) =>
    await callback(),
}));
const mocks = vi.hoisted(() => ({
  materializeWorkspaceDirectory: vi.fn<
    (
      path: string,
      options?: {
        readonly skillStoreLocation?: { readonly home?: string };
        readonly workspaceRoot?: string;
      },
    ) => Promise<readonly { readonly content: Buffer; readonly path: string }[]>
  >(async () => []),
}));

vi.mock("#runtime/workspace/seed-files.js", () => ({
  materializeWorkspaceDirectory: mocks.materializeWorkspaceDirectory,
}));

describe("prewarmAppSandboxes", () => {
  afterEach(() => {
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

  it("folds inherited child workspace and skill resources into the parent template", async () => {
    const appRoot = process.cwd();
    const inputs: SandboxBackendPrewarmInput[] = [];
    mocks.materializeWorkspaceDirectory.mockImplementation(async (path: string, options) => {
      if (path.endsWith("/parent")) {
        return [{ content: Buffer.from("parent"), path: "/workspace/parent.txt" }];
      }
      return [
        {
          content: Buffer.from("child"),
          path: `${options?.skillStoreLocation?.home}/workspace/child.txt`,
        },
        {
          content: Buffer.from("# Child skill\n"),
          path: `${options?.skillStoreLocation?.home}/.agents/skills/child/SKILL.md`,
        },
      ];
    });

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      dispatch: recordPrewarmInputs(inputs),
      loadAgentGraph: async () =>
        createGraph({
          inheritedWorkspaceResourceRoots: [
            {
              resourceRoot: {
                contentHash: "child-content-hash",
                logicalPath: "child",
                rootEntries: ["child.txt", ".agents/skills/child"],
              },
              skillStoreLocation: { home: "/agents/worker-00000000" },
            },
          ],
          workspaceResourceRoot: {
            contentHash: "parent-content-hash",
            logicalPath: "parent",
            rootEntries: ["parent.txt"],
          },
        }),
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.seedFiles.map((file) => file.path)).toEqual([
      "/agents/worker-00000000/.agents/skills/child/SKILL.md",
      "/agents/worker-00000000/workspace/child.txt",
      "/workspace/parent.txt",
    ]);
  });

  it("keeps same-named parent and child workspace seeds in separate roots", async () => {
    const appRoot = process.cwd();
    const inputs: SandboxBackendPrewarmInput[] = [];
    mocks.materializeWorkspaceDirectory.mockImplementation(async (path, options) => [
      {
        content: Buffer.from(path.endsWith("/parent") ? "parent" : "child"),
        path:
          options?.skillStoreLocation?.home === undefined
            ? "/workspace/shared.txt"
            : `${options.skillStoreLocation.home}/workspace/shared.txt`,
      },
    ]);

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      dispatch: recordPrewarmInputs(inputs),
      loadAgentGraph: async () =>
        createGraph({
          inheritedWorkspaceResourceRoots: [
            {
              resourceRoot: {
                contentHash: "child-content-hash",
                logicalPath: "child",
                rootEntries: ["shared.txt"],
              },
              skillStoreLocation: { home: "/agents/worker-00000000" },
            },
          ],
          workspaceResourceRoot: {
            contentHash: "parent-content-hash",
            logicalPath: "parent",
            rootEntries: ["shared.txt"],
          },
        }),
    });

    expect(inputs[0]?.seedFiles.map((file) => file.path)).toEqual([
      "/agents/worker-00000000/workspace/shared.txt",
      "/workspace/shared.txt",
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
    readonly inheritedWorkspaceResourceRoots?: readonly {
      readonly resourceRoot: {
        readonly contentHash?: string;
        readonly logicalPath: string;
        readonly rootEntries: readonly string[];
      };
      readonly skillStoreLocation: { readonly home?: string };
    }[];
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
        inheritedWorkspaceResourceRoots: input.inheritedWorkspaceResourceRoots ?? [],
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
