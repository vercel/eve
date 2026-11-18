import { describe, expect, it } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  type CompileMetadata,
} from "#compiler/artifact-contract.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  createRuntimeSession,
  setRuntimeSessionCompiledArtifacts,
  withRuntimeSession,
} from "#runtime/sessions/runtime-session.js";

describe("resolveRuntimeCompiledArtifactsVersionedCacheKey", () => {
  it("follows the bundled snapshot installed in the runtime session", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      model: "openai/gpt-5.4",
      name: "test-agent",
    });
    const source = createBundledRuntimeCompiledArtifactsSource();
    const session = createRuntimeSession("bundled-cache-key");

    await withRuntimeSession(session, async () => {
      setRuntimeSessionCompiledArtifacts(session, {
        manifest,
        metadata: compileMetadata("initial-graph"),
        moduleMap,
      });
      await expect(resolveRuntimeCompiledArtifactsVersionedCacheKey(source)).resolves.toBe(
        "bundled:initial-graph",
      );
      await expect(resolveRuntimeCompiledArtifactsVersionedCacheKey(source)).resolves.toBe(
        "bundled:initial-graph",
      );

      setRuntimeSessionCompiledArtifacts(session, {
        manifest,
        metadata: compileMetadata("updated-graph"),
        moduleMap,
      });
      await expect(resolveRuntimeCompiledArtifactsVersionedCacheKey(source)).resolves.toBe(
        "bundled:updated-graph",
      );
    });
  });
});

function compileMetadata(sourceGraphHash: string): CompileMetadata {
  const digest = { path: "artifact", sha256: "digest" };
  return {
    compile: { manifest: digest, moduleMap: digest },
    discovery: {
      diagnostics: digest,
      manifest: digest,
      sourceGraphHash,
      summary: { errors: 0, warnings: 0 },
    },
    generator: { name: "eve", version: "0.0.0-test" },
    kind: COMPILE_METADATA_KIND,
    status: "ready",
    version: COMPILE_METADATA_VERSION,
  };
}
