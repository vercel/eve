import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  type CompileMetadata,
} from "#compiler/artifacts.js";
import { compiledAgentManifestSchema } from "#compiler/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_MODULE,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
  TEST_COMPILED_AGENT_CONFIG_SOURCE_ID,
  TEST_COMPILED_SANDBOX_MODULE,
  TEST_COMPILED_SANDBOX_SOURCE_ID,
} from "#internal/testing/compiled-manifest.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createCompilerDiagnosticsArtifact } from "#protocol/compiler-diagnostics-artifact.js";
import { identifyCompiledModuleMap } from "#protocol/compiled-module-map-identity.js";
import { serializeArtifactJson } from "#protocol/artifact-json.js";
import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import {
  createRuntimeSandboxKeys,
  createRuntimeSandboxTemplateKey,
} from "#runtime/sandbox/keys.js";
import type { RuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";

const RUNTIME_SANDBOX_CONTRACT_VERSION = 8;

const CONTENT_HASH = "a".repeat(64);
const SOURCE_HASH = "8".repeat(64);

function createMetadataFixture(generatorVersion: string): CompileMetadata {
  return {
    compile: {
      manifest: { path: ".eve/compile/compiled-agent-manifest.json", sha256: "f".repeat(64) },
      moduleMap: {
        identitySha256: "e".repeat(64),
        path: ".eve/compile/module-map.mjs",
        sha256: "b".repeat(64),
      },
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
  const versionHash = sha256(
    JSON.stringify({
      contentHash: CONTENT_HASH,
      kind: "workspace-content",
      nodeId: "__root__",
      sourceHash: SOURCE_HASH,
      sourceId: "eve:default-sandbox",
    }),
  );
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
    templatePlan: {
      contentHash: CONTENT_HASH,
      kind: "workspace-content",
      sourceHash: SOURCE_HASH,
    },
  });
}

function withBundledMetadata<T>(metadata: CompileMetadata, fn: () => Promise<T>): Promise<T> {
  const manifest = createCompiledAgentManifest({
    kernelPlan: { prepared: [] },
    agentRoot: "/virtual/app/agent",
    appRoot: "/virtual/app",
    bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "keys-test-agent",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
  });

  const diagnostics = createCompilerDiagnosticsArtifact([]);
  const parsedManifest = compiledAgentManifestSchema.parse(manifest);
  const manifestHash = sha256(serializeArtifactJson(parsedManifest));
  const diagnosticsHash = sha256(serializeArtifactJson(diagnostics));
  const coherentMetadata: CompileMetadata = {
    ...metadata,
    compile: {
      ...metadata.compile,
      manifest: { ...metadata.compile.manifest, sha256: manifestHash },
    },
    discovery: {
      ...metadata.discovery,
      diagnostics: { ...metadata.discovery.diagnostics, sha256: diagnosticsHash },
      sourceGraphHash: sha256(
        `${metadata.discovery.manifest.sha256}:${manifestHash}:${diagnosticsHash}:${metadata.compile.moduleMap.sha256}:${metadata.compile.moduleMap.identitySha256}`,
      ),
    },
  };

  return withBundledCompiledArtifacts(
    {
      diagnostics,
      manifest: parsedManifest,
      metadata: coherentMetadata,
      moduleMap: identifyCompiledModuleMap(
        {
          nodes: {
            __root__: {
              modules: {
                [TEST_COMPILED_AGENT_CONFIG_SOURCE_ID]: TEST_COMPILED_AGENT_CONFIG_MODULE,
                [TEST_COMPILED_SANDBOX_SOURCE_ID]: TEST_COMPILED_SANDBOX_MODULE,
              },
            },
          },
        },
        coherentMetadata.compile.moduleMap.identitySha256,
      ),
    },
    fn,
  );
}

async function deriveKeys(input?: {
  readonly backendName?: string;
  readonly contentHash?: string;
  readonly sourceHash?: string;
  readonly templatePlan?: RuntimeSandboxTemplatePlan;
}): Promise<{ readonly sessionKey: string; readonly templateKey: string | null }> {
  return await createRuntimeSandboxKeys({
    backendName: input?.backendName ?? "local",
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    nodeId: "__root__",
    sessionId: "session_1",
    sourceId: "eve:default-sandbox",
    templatePlan: input?.templatePlan ?? {
      contentHash: input?.contentHash ?? CONTENT_HASH,
      kind: "workspace-content",
      sourceHash: input?.sourceHash ?? SOURCE_HASH,
    },
  });
}

async function deriveSessionKey(input?: Parameters<typeof deriveKeys>[0]): Promise<string> {
  return (await deriveKeys(input)).sessionKey;
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

  it("keeps the session key stable across unrelated discovery metadata and eve version changes", async () => {
    const changedMetadata = createMetadataFixture("2.0.0");

    const first = await withBundledMetadata(createMetadataFixture("1.0.0"), () =>
      deriveSessionKey(),
    );
    const second = await withBundledMetadata(
      {
        ...changedMetadata,
        discovery: {
          ...changedMetadata.discovery,
          manifest: { ...changedMetadata.discovery.manifest, sha256: "9".repeat(64) },
        },
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

  it("rotates the session key when the selected sandbox source identity changes", async () => {
    const first = await withBundledMetadata(createMetadataFixture("1.0.0"), () => deriveKeys());
    const changed = await withBundledMetadata(createMetadataFixture("1.0.0"), () =>
      deriveKeys({ sourceHash: "9".repeat(64) }),
    );

    expect(changed.sessionKey).not.toBe(first.sessionKey);
    expect(changed.templateKey).not.toBe(first.templateKey);
  });

  it("keeps a nonempty workspace key stable when an unrelated module changes", async () => {
    const firstMetadata = createMetadataFixture("1.0.0");
    const secondMetadata = {
      ...firstMetadata,
      compile: {
        ...firstMetadata.compile,
        moduleMap: {
          ...firstMetadata.compile.moduleMap,
          identitySha256: "9".repeat(64),
        },
      },
    };
    const first = await withBundledMetadata(firstMetadata, () =>
      deriveKeys({ contentHash: CONTENT_HASH }),
    );
    const changed = await withBundledMetadata(secondMetadata, () =>
      deriveKeys({ contentHash: CONTENT_HASH }),
    );

    expect(changed).toEqual(first);
  });

  it("keeps a bootstrap-only session key stable when unrelated graph metadata changes", async () => {
    const firstMetadata = createMetadataFixture("1.0.0");
    const changedMetadata = {
      ...createMetadataFixture("2.0.0"),
      compile: {
        ...firstMetadata.compile,
        moduleMap: {
          ...firstMetadata.compile.moduleMap,
          identitySha256: "9".repeat(64),
        },
      },
      discovery: {
        ...firstMetadata.discovery,
        sourceGraphHash: "7".repeat(64),
      },
    };
    const templatePlan = {
      kind: "bootstrap",
      sourceHash: SOURCE_HASH,
    } as const;
    const first = await withBundledMetadata(firstMetadata, () =>
      deriveSessionKey({ templatePlan }),
    );
    const changed = await withBundledMetadata(changedMetadata, () =>
      deriveSessionKey({ templatePlan }),
    );

    expect(changed).toBe(first);
  });

  it("versions a template-free session by its selected sandbox source", async () => {
    const metadata = createMetadataFixture("1.0.0");
    const first = await withBundledMetadata(
      metadata,
      async () =>
        await createRuntimeSandboxKeys({
          backendName: "local",
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          nodeId: "__root__",
          sessionId: "session_1",
          sourceId: "eve:default-sandbox",
          templatePlan: { kind: "none", sourceHash: SOURCE_HASH },
        }),
    );
    const changed = await withBundledMetadata(
      metadata,
      async () =>
        await createRuntimeSandboxKeys({
          backendName: "local",
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          nodeId: "__root__",
          sessionId: "session_1",
          sourceId: "eve:default-sandbox",
          templatePlan: { kind: "none", sourceHash: "9".repeat(64) },
        }),
    );

    expect(first.templateKey).toBeNull();
    expect(changed.templateKey).toBeNull();
    expect(changed.sessionKey).not.toBe(first.sessionKey);
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
});
