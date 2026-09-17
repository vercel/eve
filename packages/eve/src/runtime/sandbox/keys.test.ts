import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createRuntimeSandboxTemplateKey } from "#runtime/sandbox/keys.js";

async function key(providerName = "docker") {
  return await createRuntimeSandboxTemplateKey({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    nodeId: "__root__",
    providerName,
    sourceId: "sandbox.ts",
    templatePlan: { contentHash: "content", revisionHash: "revision" },
  });
}

describe("createRuntimeSandboxTemplateKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is deterministic", async () => {
    await expect(key()).resolves.toBe(await key());
  });

  it("partitions providers", async () => {
    expect(await key("docker")).not.toBe(await key("vercel"));
  });

  it("uses Vercel project scope rather than deployment scope", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_test");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "first");
    const first = await key("vercel");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "second");
    expect(await key("vercel")).toBe(first);
  });

  it("reads Vercel project scope from OIDC", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createFakeVercelOidcToken({ project_id: "prj_oidc" }));
    await expect(key("vercel")).resolves.toContain("eve-sbx-tpl-vercel-");
  });
});
