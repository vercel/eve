import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import {
  createRuntimeSandboxDefinitionRevision,
  createRuntimeSandboxSessionKey,
  createRuntimeSandboxTemplateKey,
} from "../../src/runtime/sandbox/keys.js";

const createScratchDirectory = useTemporaryDirectories();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("disk-backed runtime sandbox identities", () => {
  it("is stable for the same real app root and isolated across app roots", async () => {
    stubNoVercelProject();
    const firstRoot = await createTemporaryAppRoot();
    const secondRoot = await createTemporaryAppRoot();

    const first = await templateKey(firstRoot);
    const repeated = await templateKey(firstRoot);
    const second = await templateKey(secondRoot);

    expect(repeated).toBe(first);
    expect(second).not.toBe(first);
  });

  it("uses the authored workspace digest in the compatibility revision", async () => {
    const first = await createRuntimeSandboxDefinitionRevision({
      nodeId: "__root__",
      sourceHash: "source",
      sourceId: "agent/sandbox/sandbox",
      workspaceResourceRoot: {
        contentHash: "workspace-v1",
        logicalPath: "workspace",
        rootEntries: ["README.md"],
      },
    });
    const second = await createRuntimeSandboxDefinitionRevision({
      nodeId: "__root__",
      sourceHash: "source",
      sourceId: "agent/sandbox/sandbox",
      workspaceResourceRoot: {
        contentHash: "workspace-v2",
        logicalPath: "workspace",
        rootEntries: ["README.md"],
      },
    });

    expect(second).not.toBe(first);
  });

  it("ignores deployment and team ids while retaining project scope", async () => {
    const appRoot = await createTemporaryAppRoot();
    const source = createDiskRuntimeCompiledArtifactsSource(appRoot);
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_first");
    vi.stubEnv("VERCEL_TEAM_ID", "team_build");
    const first = await createRuntimeSandboxSessionKey({
      compiledArtifactsSource: source,
      nodeId: "__root__",
      revision: "revision",
      sessionId: "session_1",
    });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_second");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    const second = await createRuntimeSandboxSessionKey({
      compiledArtifactsSource: source,
      nodeId: "__root__",
      revision: "revision",
      sessionId: "session_1",
    });

    expect(second).toBe(first);
  });
});

async function templateKey(appRoot: string): Promise<string> {
  return await createRuntimeSandboxTemplateKey({
    compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
    exportName: "template",
    implementationId: "provider-v1",
    nodeId: "__root__",
    revision: "revision-v1",
  });
}

async function createTemporaryAppRoot(): Promise<string> {
  const appRoot = await createScratchDirectory("eve-sandbox-keys-");
  await mkdir(join(appRoot, ".eve", "compile"), { recursive: true });
  await writeFile(
    join(appRoot, ".eve", "compile", "compile-metadata.json"),
    `${JSON.stringify({
      compile: {
        moduleMap: { path: ".eve/compile/module-map.mjs", sha256: "deadbeef" },
      },
      discovery: {
        diagnostics: { path: ".eve/discovery/diagnostics.json", sha256: "deadbeef" },
        manifest: { path: ".eve/discovery/agent-discovery-manifest.json", sha256: "deadbeef" },
        sourceGraphHash: "source-graph",
        summary: { errors: 0, warnings: 0 },
      },
      generator: { name: "eve", version: "0.0.0-test" },
      kind: "eve-compile-metadata",
      status: "ready",
      version: 5,
    })}\n`,
  );
  return appRoot;
}

function stubNoVercelProject(): void {
  vi.stubEnv("VERCEL_PROJECT_ID", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
}
