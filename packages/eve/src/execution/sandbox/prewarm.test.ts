import { describe, expect, it, vi } from "vitest";

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

describe("prewarmAppSandboxes", () => {
  it("uses the stable sandbox app root for dev snapshot artifact sources", async () => {
    const appRoot = process.cwd();
    const firstSnapshotRoot = `${appRoot}/.eve/dev-runtime/snapshots/one/app`;
    const secondSnapshotRoot = `${appRoot}/.eve/dev-runtime/snapshots/two/app`;
    const firstInputs: SandboxBackendPrewarmInput[] = [];
    const secondInputs: SandboxBackendPrewarmInput[] = [];

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(firstSnapshotRoot, {
        moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
        sandboxAppRoot: appRoot,
      }),
      dispatch: recordPrewarmInputs(firstInputs),
      loadAgentGraph: async () => createGraph(),
    });
    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(secondSnapshotRoot, {
        moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
        sandboxAppRoot: appRoot,
      }),
      dispatch: recordPrewarmInputs(secondInputs),
      loadAgentGraph: async () => createGraph(),
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

function createGraph(): ResolvedAgentGraphBundle {
  const backend: SandboxBackend = {
    async create() {
      throw new Error("Unexpected create call.");
    },
    name: "test",
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
        workspaceResourceRoot: {
          contentHash: "workspace-content-hash",
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
