import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  createRuntimeSandboxDefinitionRevision,
  createRuntimeSandboxSessionKey,
  createRuntimeSandboxTemplateKey,
} from "#runtime/sandbox/keys.js";

const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();

describe("private runtime sandbox identities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("changes the definition revision with authored source, workspace, or node", async () => {
    const baseline = await definitionRevision();

    expect(await definitionRevision()).toBe(baseline);
    expect(await definitionRevision({ sourceHash: "source-v2" })).not.toBe(baseline);
    expect(await definitionRevision({ contentHash: "workspace-v2" })).not.toBe(baseline);
    expect(await definitionRevision({ nodeId: "reviewer" })).not.toBe(baseline);
  });

  it("keeps a session resource stable across Vercel deployments", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_first");
    const first = await sessionKey();

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_second");
    const second = await sessionKey();

    expect(second).toBe(first);
  });

  it("uses the same project scope from the project env and OIDC claim", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    const fromEnvironment = await sessionKey();

    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createFakeVercelOidcToken({ project_id: "prj_123" }));
    const fromToken = await sessionKey();

    expect(fromToken).toBe(fromEnvironment);
  });

  it("changes the session resource with the session, node, or compatibility revision", async () => {
    const baseline = await sessionKey();

    expect(await sessionKey({ sessionId: "session_2" })).not.toBe(baseline);
    expect(await sessionKey({ nodeId: "reviewer" })).not.toBe(baseline);
    expect(await sessionKey({ revision: "revision-v2" })).not.toBe(baseline);
  });

  it("changes a template identity with its implementation, export, node, or revision", async () => {
    const baseline = await templateKey();

    expect(await templateKey({ implementationId: "provider-v2" })).not.toBe(baseline);
    expect(await templateKey({ exportName: "python" })).not.toBe(baseline);
    expect(await templateKey({ nodeId: "reviewer" })).not.toBe(baseline);
    expect(await templateKey({ revision: "revision-v2" })).not.toBe(baseline);
  });
});

async function definitionRevision(
  input: {
    readonly contentHash?: string;
    readonly nodeId?: string;
    readonly sourceHash?: string;
  } = {},
): Promise<string> {
  return await createRuntimeSandboxDefinitionRevision({
    nodeId: input.nodeId ?? "__root__",
    sourceHash: input.sourceHash ?? "source-v1",
    sourceId: "agent/sandbox/sandbox",
    workspaceResourceRoot: {
      contentHash: input.contentHash ?? "workspace-v1",
      logicalPath: "agent/sandbox/workspace",
      rootEntries: ["README.md"],
    },
  });
}

async function sessionKey(
  input: {
    readonly nodeId?: string;
    readonly revision?: string;
    readonly sessionId?: string;
  } = {},
): Promise<string> {
  return await createRuntimeSandboxSessionKey({
    compiledArtifactsSource,
    nodeId: input.nodeId ?? "__root__",
    revision: input.revision ?? "revision-v1",
    sessionId: input.sessionId ?? "session_1",
  });
}

async function templateKey(
  input: {
    readonly exportName?: string;
    readonly implementationId?: string;
    readonly nodeId?: string;
    readonly revision?: string;
  } = {},
): Promise<string> {
  return await createRuntimeSandboxTemplateKey({
    compiledArtifactsSource,
    exportName: input.exportName ?? "template",
    implementationId: input.implementationId ?? "provider-v1",
    nodeId: input.nodeId ?? "__root__",
    revision: input.revision ?? "revision-v1",
  });
}
