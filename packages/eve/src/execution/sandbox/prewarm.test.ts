import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prewarmAppSandboxes,
  type SandboxPreparedArtifactStore,
} from "#execution/sandbox/prewarm.js";
import {
  defineSandboxProvider,
  type SandboxProviderPrepareContext,
} from "#shared/sandbox-provider.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID, type ResolvedAgentGraphBundle } from "#runtime/graph.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";

const mocks = vi.hoisted(() => ({
  materializeWorkspaceDirectory: vi.fn<
    (path: string) => Promise<readonly { readonly content: Buffer; readonly path: string }[]>
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
    const firstInputs: SandboxProviderPrepareContext[] = [];
    const secondInputs: SandboxProviderPrepareContext[] = [];
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
      preparedArtifactStore: createMemoryArtifactStore(),
    });
    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(secondSnapshotRoot, {
        moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
        sandboxAppRoot: appRoot,
      }),
      dispatch: recordPrewarmInputs(secondInputs),
      loadAgentGraph: async () => createGraph({ workspaceResourceRoot }),
      preparedArtifactStore: createMemoryArtifactStore(),
    });

    expect(firstInputs).toHaveLength(1);
    expect(secondInputs).toHaveLength(1);
    expect(firstInputs[0]?.storagePath).toBe(resolveSandboxCacheDirectory(appRoot));
    expect(secondInputs[0]?.storagePath).toBe(resolveSandboxCacheDirectory(appRoot));
    expect(firstInputs[0]?.sourceRevision).toBe("sandbox-source-hash");
    expect(secondInputs[0]?.sourceRevision).toBe("sandbox-source-hash");
  });

  it("waits for other providers to finish before reporting a preparation failure", async () => {
    const graph = createGraph();
    const child = { ...graph.root, nodeId: "child" };
    const nodesByNodeId = new Map(graph.nodesByNodeId);
    nodesByNodeId.set("child", child);
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    let settled = false;
    const preparation = prewarmAppSandboxes({
      appRoot: process.cwd(),
      loadAgentGraph: async () => ({ ...graph, nodesByNodeId }),
      dispatch: async () => {
        if (++calls === 1) throw new Error("first provider failed");
        await slow;
        return null;
      },
      preparedArtifactStore: createMemoryArtifactStore(),
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(settled).toBe(false);
    finish();
    expect(await preparation).toMatchObject({ message: "first provider failed" });
  });

  it.each(["docker", "microsandbox"])(
    "explains that %s is unavailable during Vercel prewarm",
    async (providerName) => {
      vi.stubEnv("VERCEL", "1");

      const appRoot = process.cwd();
      const cause = new Error("provider host check failed");
      const log = vi.fn();

      await expect(
        prewarmAppSandboxes({
          appRoot,
          compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
          dispatch: async () => {
            throw cause;
          },
          loadAgentGraph: async () => createGraph({ providerName }),
          log,
        }),
      ).rejects.toMatchObject({
        cause,
        message: expect.stringContaining(
          `The ${providerName} sandbox provider is not available when deploying on Vercel.`,
        ),
      });

      const messages = log.mock.calls.map(([message]) => String(message));
      expect(messages).toEqual([
        "eve: initializing 1 sandbox template...",
        expect.stringContaining(
          `The ${providerName} sandbox provider is not available when deploying on Vercel.`,
        ),
      ]);
      expect(messages[1]).toContain("Use DefaultSandbox.environment()");
      expect(messages[1]).toContain("VercelSandbox.environment() explicitly");
      expect(messages[1]).toContain("Original");
      expect(messages[1]).toContain(cause.message);
    },
  );
});

function createMemoryArtifactStore(): SandboxPreparedArtifactStore {
  return { async write() {} };
}

function recordPrewarmInputs(inputs: SandboxProviderPrepareContext[]) {
  return async ({ context }: { context: SandboxProviderPrepareContext }) => {
    inputs.push(context);
    return null;
  };
}

function createGraph(
  input: {
    readonly providerName?: string;
    readonly workspaceResourceRoot?: {
      readonly contentHash?: string;
      readonly logicalPath: string;
      readonly rootEntries: readonly string[];
    };
  } = {},
): ResolvedAgentGraphBundle {
  const provider = defineSandboxProvider({
    name: input.providerName ?? "test",
    environment: () => ({
      async prepare() {
        return null;
      },
      async resume() {
        throw new Error("Unexpected resume call.");
      },
      async start() {
        throw new Error("Unexpected start call.");
      },
    }),
  });
  const environment = provider.environment();
  const definition: ResolvedSandboxDefinition = {
    environment,
    kind: "independent",
    logicalPath: "agent/sandbox/sandbox.ts",
    selector: defineSandbox(() => environment.open()),
    revisionHash: "sandbox-source-hash",
    sourceId: "agent/sandbox/sandbox",
    sourceKind: "module",
  };
  const root = {
    agent: { metadata: { agentRoot: process.cwd(), appRoot: process.cwd() } },
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
