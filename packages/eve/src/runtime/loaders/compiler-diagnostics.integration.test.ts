import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import {
  LoadCompiledArtifactSetError,
  loadCompiledArtifactSet,
} from "#runtime/loaders/compiled-artifact-set.js";
import { loadCompilerDiagnosticsArtifact } from "#runtime/loaders/compiler-diagnostics.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

describe("compiler diagnostics transport", () => {
  it("round-trips the required artifact through a bundled runtime snapshot", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5.4" });
    const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();

    await withBundledCompiledArtifacts(
      { ...compiled, sessionId: "diagnostics-bundled-round-trip" },
      async () => {
        const manifest = await loadCompiledManifest({ compiledArtifactsSource });

        await expect(
          loadCompilerDiagnosticsArtifact({ compiledArtifactsSource, manifest }),
        ).resolves.toEqual(compiled.diagnostics);
        await expect(loadCompiledArtifactSet({ compiledArtifactsSource })).resolves.toMatchObject({
          diagnostics: compiled.diagnostics,
          manifest: compiled.manifest,
          metadata: compiled.metadata,
        });
      },
    );
  });

  it("rejects relational mismatch before consulting bundled modules", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5.4" });
    let moduleMapRead = false;
    const moduleMap = new Proxy(compiled.moduleMap, {
      get(target, property, receiver) {
        moduleMapRead = true;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      withBundledCompiledArtifacts(
        {
          diagnostics: compiled.diagnostics,
          manifest: {
            ...compiled.manifest,
            diagnosticsSummary: { errors: 0, warnings: 1 },
          },
          metadata: compiled.metadata,
          moduleMap,
        },
        () => undefined,
      ),
    ).rejects.toThrow("does not match diagnosticsSummary");

    expect(moduleMapRead).toBe(false);
  });

  it.each(["compiled manifest", "source graph"] as const)(
    "rejects a bundled %s digest mismatch before loading modules",
    async (mismatch) => {
      const compiled = await compileFromMemory({ model: "openai/gpt-5.4" });
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const metadata =
        mismatch === "compiled manifest"
          ? {
              ...compiled.metadata,
              compile: {
                ...compiled.metadata.compile,
                manifest: {
                  ...compiled.metadata.compile.manifest,
                  sha256: "0".repeat(64),
                },
              },
            }
          : {
              ...compiled.metadata,
              discovery: {
                ...compiled.metadata.discovery,
                sourceGraphHash: "0".repeat(64),
              },
            };

      await withBundledCompiledArtifacts(
        {
          ...compiled,
          metadata,
          sessionId: `diagnostics-bundled-${mismatch.replaceAll(" ", "-")}-mismatch`,
        },
        async () => {
          await expect(loadCompiledArtifactSet({ compiledArtifactsSource })).rejects.toBeInstanceOf(
            LoadCompiledArtifactSetError,
          );
        },
      );
    },
  );

  it("rejects missing metadata and failed metadata before installing a bundle", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5.4" });

    await expect(
      withBundledCompiledArtifacts(
        {
          diagnostics: compiled.diagnostics,
          manifest: compiled.manifest,
          moduleMap: compiled.moduleMap,
        } as Parameters<typeof withBundledCompiledArtifacts>[0],
        () => undefined,
      ),
    ).rejects.toThrow("invalid compile metadata");
    await expect(
      withBundledCompiledArtifacts(
        {
          ...compiled,
          metadata: { ...compiled.metadata, status: "failed" },
        },
        () => undefined,
      ),
    ).rejects.toThrow('status must be "ready"');
  });
});
