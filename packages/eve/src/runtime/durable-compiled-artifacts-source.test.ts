import { afterEach, describe, expect, it, vi } from "vitest";

import { withDevelopmentWorkflowGeneration } from "#internal/workflow/development-generation-context.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  resolveDurableCompiledArtifactsSource,
  serializeDurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("durable compiled artifact sources", () => {
  it("preserves deployed artifact sources", () => {
    const source = createDiskRuntimeCompiledArtifactsSource("/var/task/.eve/compile");

    expect(serializeDurableCompiledArtifactsSource(source)).toBe(source);
  });

  it("persists a logical selector and resolves it from the admitted child generation", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const original = createDiskRuntimeCompiledArtifactsSource(
      "/app/.eve/dev-runtime/snapshots/generation-a/source/app",
    );
    const admitted = createDiskRuntimeCompiledArtifactsSource(
      "/app/.eve/dev-runtime/snapshots/generation-b/source/app",
    );
    const durable = serializeDurableCompiledArtifactsSource(original);

    expect(durable).toEqual({ kind: "development" });
    expect(JSON.stringify(durable)).not.toContain("generation-a");
    await withDevelopmentWorkflowGeneration(
      { generationId: "generation-b", source: admitted },
      async () => {
        expect(resolveDurableCompiledArtifactsSource(durable)).toBe(admitted);
      },
    );
  });
});
