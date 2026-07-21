import { describe, expect, it } from "vitest";

import { withDevelopmentWorkflowGeneration } from "#internal/workflow/development-generation-context.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  resolveDurableCompiledArtifactsSource,
  serializeDurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";

describe("durable compiled artifact sources", () => {
  it("preserves deployed artifact sources", () => {
    const source = createDiskRuntimeCompiledArtifactsSource("/var/task/.eve/compile");

    expect(serializeDurableCompiledArtifactsSource(source)).toBe(source);
  });

  it("persists a logical selector and resolves it from the admitted child generation", async () => {
    const original = createDiskRuntimeCompiledArtifactsSource(
      "/app/.eve/dev-runtime/snapshots/generation-a/source/app",
      { durableReference: "development-generation" },
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

  it("stores untagged development sources verbatim and resolves them without delivery context", () => {
    // A custom World's deliveries never install a generation context, so
    // its payloads must pin their exact snapshot instead of a selector.
    const source = createDiskRuntimeCompiledArtifactsSource(
      "/app/.eve/dev-runtime/snapshots/generation-a/source/app",
      { moduleMapLoaderPath: "/pkg/loader.ts", sandboxAppRoot: "/app" },
    );

    const durable = serializeDurableCompiledArtifactsSource(source);
    expect(durable).toBe(source);
    expect(resolveDurableCompiledArtifactsSource(durable)).toBe(source);
  });

  it("rejects resolving a logical selector outside a generation-bound delivery", () => {
    const durable = serializeDurableCompiledArtifactsSource(
      createDiskRuntimeCompiledArtifactsSource("/app/.eve/dev-runtime/snapshots/g/source/app", {
        durableReference: "development-generation",
      }),
    );
    expect(() => resolveDurableCompiledArtifactsSource(durable)).toThrow(
      "outside a generation-bound delivery",
    );
  });
});
