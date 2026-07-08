import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
} from "../../src/runtime/compiled-artifacts-source.js";
import { createRuntimeSandboxTemplateKey } from "../../src/runtime/sandbox/keys.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

/**
 * Scenario-tier coverage for `createRuntimeSandboxTemplateKey`. The key
 * derivation reads `compile-metadata.json` off the real filesystem and
 * resolves template scopes via `realpath(appRoot)` — both are intentional
 * dependencies on disk semantics that the integration tier no longer
 * admits. The equivalent in-memory coverage of the authored-grammar rules
 * lives in the discover/compile integration tier; here we prove the
 * disk-backed fallback paths behave as documented.
 */
const createScratchDirectory = useTemporaryDirectories();
const BOOTSTRAP_SOURCE_HASH = "bootstrap-source-hash";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function createTemporaryAppRoot(options?: { sourceGraphHash?: string }): Promise<string> {
  const appRoot = await createScratchDirectory("eve-sbx-keys-");
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
        sourceGraphHash: options?.sourceGraphHash ?? "test-source-graph-hash",
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

const WORKSPACE_PLAN = { contentHash: "workspace-hash", kind: "workspace-content" } as const;

function stubEmptyVercelProjectSources(): void {
  vi.stubEnv("VERCEL_PROJECT_ID", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  // A deployment id must never participate in template scopes; set one to
  // prove the fallback ignores it.
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_123");
}

describe("createRuntimeSandboxTemplateKey", () => {
  it("falls back to the realpath of the disk app root for the Vercel adapter when no project id is resolvable", async () => {
    stubEmptyVercelProjectSources();

    const appRoot = await createTemporaryAppRoot();
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource,
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: WORKSPACE_PLAN,
    });

    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource,
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: WORKSPACE_PLAN,
    });

    expect(firstKey).toMatch(/^eve-sbx-tpl-vercel-/);
    expect(secondKey).toBe(firstKey);
  });

  it("isolates Vercel template keys per app root when no project id is resolvable", async () => {
    stubEmptyVercelProjectSources();

    const firstAppRoot = await createTemporaryAppRoot();
    const secondAppRoot = await createTemporaryAppRoot();

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(firstAppRoot),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: WORKSPACE_PLAN,
    });
    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(secondAppRoot),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: WORKSPACE_PLAN,
    });

    expect(firstKey).not.toBe(secondKey);
  });

  it("falls back to the bundled cache key for the Vercel adapter when no app root and no project id are available", async () => {
    stubEmptyVercelProjectSources();

    const key = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: WORKSPACE_PLAN,
    });

    expect(key).toMatch(/^eve-sbx-tpl-vercel-/);
  });

  it("uses stable Vercel project scope for workspace-content templates", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_one");

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "eve:default-sandbox",
      templatePlan: { contentHash: "workspace-hash", kind: "workspace-content" },
    });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_two");

    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "eve:default-sandbox",
      templatePlan: { contentHash: "workspace-hash", kind: "workspace-content" },
    });

    expect(secondKey).toBe(firstKey);
  });

  it("uses stable Vercel project scope for bootstrap templates", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_one");

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash",
        kind: "bootstrap",
        revalidationKey: "bootstrap-day-1",
        sourceHash: BOOTSTRAP_SOURCE_HASH,
      },
    });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_two");

    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash",
        kind: "bootstrap",
        revalidationKey: "bootstrap-day-1",
        sourceHash: BOOTSTRAP_SOURCE_HASH,
      },
    });

    expect(secondKey).toBe(firstKey);
  });

  it("ignores VERCEL_TEAM_ID so build-time prewarm and deployed runtime agree", async () => {
    // Vercel has no team system variable at runtime, so a team-scoped key
    // could never be resolved by the deployed function.
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_team_parity");

    const input = {
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "eve:default-sandbox",
      templatePlan: { contentHash: "workspace-hash", kind: "workspace-content" },
    } as const;

    vi.stubEnv("VERCEL_TEAM_ID", "team_build");
    const buildKey = await createRuntimeSandboxTemplateKey(input);

    vi.stubEnv("VERCEL_TEAM_ID", "");
    const runtimeKey = await createRuntimeSandboxTemplateKey(input);

    expect(runtimeKey).toBe(buildKey);
  });

  it("uses source and workspace inputs for bootstrap templates without a revalidation key", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap");

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash",
        kind: "bootstrap",
        sourceHash: BOOTSTRAP_SOURCE_HASH,
      },
    });
    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash",
        kind: "bootstrap",
        sourceHash: BOOTSTRAP_SOURCE_HASH,
      },
    });

    expect(secondKey).toBe(firstKey);
  });

  it("changes bootstrap template keys when the revalidation key changes", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap");

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash",
        kind: "bootstrap",
        revalidationKey: "bootstrap-day-1",
        sourceHash: BOOTSTRAP_SOURCE_HASH,
      },
    });
    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash",
        kind: "bootstrap",
        revalidationKey: "bootstrap-day-2",
        sourceHash: BOOTSTRAP_SOURCE_HASH,
      },
    });

    expect(secondKey).not.toBe(firstKey);
  });

  it("changes bootstrap template keys when authored sandbox source changes", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap");

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash",
        kind: "bootstrap",
        revalidationKey: "bootstrap-day-1",
        sourceHash: "bootstrap-source-hash-one",
      },
    });
    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash",
        kind: "bootstrap",
        revalidationKey: "bootstrap-day-1",
        sourceHash: "bootstrap-source-hash-two",
      },
    });

    expect(secondKey).not.toBe(firstKey);
  });

  it("changes bootstrap template keys when workspace content changes", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap");

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash-one",
        kind: "bootstrap",
        revalidationKey: "bootstrap-day-1",
        sourceHash: BOOTSTRAP_SOURCE_HASH,
      },
    });
    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "sandbox/sandbox.ts",
      templatePlan: {
        contentHash: "workspace-hash-two",
        kind: "bootstrap",
        revalidationKey: "bootstrap-day-1",
        sourceHash: BOOTSTRAP_SOURCE_HASH,
      },
    });

    expect(secondKey).not.toBe(firstKey);
  });

  it("changes workspace-content template keys when the content hash changes", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");

    const firstKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "eve:default-sandbox",
      templatePlan: { contentHash: "workspace-hash-one", kind: "workspace-content" },
    });
    const secondKey = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "eve:default-sandbox",
      templatePlan: { contentHash: "workspace-hash-two", kind: "workspace-content" },
    });

    expect(secondKey).not.toBe(firstKey);
  });

  it("returns null for sandboxes that do not need a template", async () => {
    const key = await createRuntimeSandboxTemplateKey({
      backendName: "vercel",
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      sourceId: "eve:default-sandbox",
      templatePlan: { kind: "none" },
    });

    expect(key).toBeNull();
  });
});
