import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  type CompileMetadata,
} from "#compiler/artifacts.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import {
  createRuntimeSandboxKeys,
  createRuntimeSandboxTemplateKey,
} from "#runtime/sandbox/keys.js";

const RUNTIME_SANDBOX_CONTRACT_VERSION = 7;

const CONTENT_HASH = "a".repeat(64);

function createMetadataFixture(generatorVersion: string): CompileMetadata {
  return {
    compile: {
      moduleMap: { path: ".eve/compile/module-map.mjs", sha256: "b".repeat(64) },
    },
    discovery: {
      diagnostics: { path: ".eve/discovery/diagnostics.json", sha256: "c".repeat(64) },
      manifest: { path: ".eve/discovery/agent-discovery-manifest.json", sha256: "d".repeat(64) },
      sourceGraphHash: "e".repeat(64),
      summary: { errors: 0, warnings: 0 },
    },
    generator: { name: "eve", version: generatorVersion },
    kind: COMPILE_METADATA_KIND,
    status: "ready",
    version: COMPILE_METADATA_VERSION,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedTemplateKey(input: { scopeSource: string; version: string }): string {
  const scope = sha256(input.scopeSource).slice(0, 16);
  const versionHash = sha256(`workspace-content:${CONTENT_HASH}:__root__:eve:default-sandbox`);
  const templateHash = sha256(
    `${input.version}:${RUNTIME_SANDBOX_CONTRACT_VERSION}:${versionHash}`,
  ).slice(0, 20);
  return `eve-sbx-tpl-local-${scope}-${templateHash}`;
}

async function deriveTemplateKey(): Promise<string | null> {
  return await createRuntimeSandboxTemplateKey({
    backendName: "local",
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    nodeId: "__root__",
    sourceId: "eve:default-sandbox",
    templatePlan: { contentHash: CONTENT_HASH, kind: "workspace-content" },
  });
}

function withBundledMetadata<T>(
  metadata: CompileMetadata | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const manifest = createCompiledAgentManifest({
    agentRoot: "/virtual/app/agent",
    appRoot: "/virtual/app",
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "keys-test-agent",
    },
  });

  return withBundledCompiledArtifacts({ manifest, metadata, moduleMap: { nodes: {} } }, fn);
}

async function deriveSessionKey(input?: {
  readonly backendName?: string;
  readonly contentHash?: string;
}): Promise<string> {
  const keys = await createRuntimeSandboxKeys({
    backendName: input?.backendName ?? "local",
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    nodeId: "__root__",
    sessionId: "session_1",
    sourceId: "eve:default-sandbox",
    templatePlan: {
      contentHash: input?.contentHash ?? CONTENT_HASH,
      kind: "workspace-content",
    },
  });
  return keys.sessionKey;
}

/**
 * Derives one vercel-backed session key under exactly the given env.
 * Unlisted project and deployment variables are stubbed empty so ambient
 * CI values cannot leak into the derivation.
 */
async function deriveVercelSessionKey(env: Record<string, string>): Promise<string> {
  const stubbed = {
    VERCEL_DEPLOYMENT_ID: "",
    VERCEL_OIDC_TOKEN: "",
    VERCEL_PROJECT_ID: "",
    ...env,
  };
  for (const [key, value] of Object.entries(stubbed)) {
    vi.stubEnv(key, value);
  }

  return await withBundledMetadata(createMetadataFixture("1.0.0"), () =>
    deriveSessionKey({ backendName: "vercel" }),
  );
}

describe("createRuntimeSandboxKeys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins the vercel session key across deployments when only the OIDC token names the project", async () => {
    const token = createFakeVercelOidcToken({ project_id: "prj_123" });

    const first = await deriveVercelSessionKey({
      VERCEL_DEPLOYMENT_ID: "dpl_first",
      VERCEL_OIDC_TOKEN: token,
    });
    const second = await deriveVercelSessionKey({
      VERCEL_DEPLOYMENT_ID: "dpl_second",
      VERCEL_OIDC_TOKEN: token,
    });

    expect(first).toBe(second);
  });

  it("derives the same session key from the project id env var and the OIDC token claim", async () => {
    const fromEnv = await deriveVercelSessionKey({ VERCEL_PROJECT_ID: "prj_123" });
    const fromToken = await deriveVercelSessionKey({
      VERCEL_OIDC_TOKEN: createFakeVercelOidcToken({ project_id: "prj_123" }),
    });

    expect(fromEnv).toBe(fromToken);
  });

  it("never scopes the session key by deployment id, even without a resolvable project id", async () => {
    const first = await deriveVercelSessionKey({ VERCEL_DEPLOYMENT_ID: "dpl_first" });
    const second = await deriveVercelSessionKey({ VERCEL_DEPLOYMENT_ID: "dpl_second" });

    expect(first).toBe(second);
  });

  it("keeps the session key stable across unrelated source and eve version changes", async () => {
    const changedMetadata = createMetadataFixture("2.0.0");

    const first = await withBundledMetadata(createMetadataFixture("1.0.0"), () =>
      deriveSessionKey(),
    );
    const second = await withBundledMetadata(
      {
        ...changedMetadata,
        discovery: { ...changedMetadata.discovery, sourceGraphHash: "f".repeat(64) },
      },
      () => deriveSessionKey(),
    );

    expect(first).toBe(second);
  });

  it("rotates the session key when the sandbox content changes", async () => {
    const first = await withBundledMetadata(createMetadataFixture("1.0.0"), () =>
      deriveSessionKey(),
    );
    const second = await withBundledMetadata(createMetadataFixture("1.0.0"), () =>
      deriveSessionKey({ contentHash: "b".repeat(64) }),
    );

    expect(first).not.toBe(second);
  });
});

describe("createRuntimeSandboxTemplateKey", () => {
  it("derives the version segment from compile metadata so build and runtime agree", async () => {
    const templateKey = await withBundledMetadata(
      createMetadataFixture("9.9.9-test"),
      deriveTemplateKey,
    );

    expect(templateKey).toBe(
      expectedTemplateKey({ scopeSource: "bundled", version: "9.9.9-test" }),
    );
    // The installed package version must not leak into the key: a deployed
    // bundle cannot resolve it and would otherwise diverge from the prewarm.
    expect(templateKey).not.toBe(
      expectedTemplateKey({
        scopeSource: "bundled",
        version: resolveInstalledPackageInfo().version,
      }),
    );
  });

  it("changes the template key when the compiled generator version changes", async () => {
    const first = await withBundledMetadata(createMetadataFixture("1.0.0"), deriveTemplateKey);
    const second = await withBundledMetadata(createMetadataFixture("2.0.0"), deriveTemplateKey);

    expect(first).not.toBe(second);
  });

  it("falls back to the installed package version without compile metadata", async () => {
    const templateKey = await withBundledMetadata(undefined, deriveTemplateKey);

    expect(templateKey).toBe(
      expectedTemplateKey({
        scopeSource: "bundled",
        version: resolveInstalledPackageInfo().version,
      }),
    );
  });
});
