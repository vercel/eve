import { describe, expect, it } from "vitest";

import { createCompileMetadata, resolveCompilerArtifactPaths } from "#compiler/artifacts.js";
import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  readBundledCompiledArtifacts,
  withBundledCompiledArtifacts,
} from "#runtime/loaders/bundled-artifacts.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  createRuntimeSession,
  getActiveRuntimeSession,
  setRuntimeSessionCompiledArtifacts,
  withRuntimeSession,
} from "#runtime/sessions/runtime-session.js";

describe("withBundledCompiledArtifacts", () => {
  it("installs artifacts only for the scoped runtime session", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      model: "openai/gpt-5.4",
      name: "test-agent",
    });

    await withRuntimeSession(createRuntimeSession("outer"), async () => {
      expect(readBundledCompiledArtifacts()).toBeNull();

      const inner = await withBundledCompiledArtifacts(
        {
          manifest,
          moduleMap,
          sessionId: "inner",
        },
        () => ({
          artifacts: readBundledCompiledArtifacts(),
          sessionId: getActiveRuntimeSession().id,
        }),
      );

      expect(inner.sessionId).toBe("inner");
      expect(inner.artifacts?.manifest).toBe(manifest);
      expect(readBundledCompiledArtifacts()).toBeNull();
    });
  });

  it("invalidates resolved bundles when the installed snapshot changes", async () => {
    const initial = await compileFromMemory({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      model: "openai/gpt-5.4",
      name: "test-agent",
    });
    const updated = await compileFromMemory({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      model: "openai/gpt-5.4",
      name: "test-agent",
      skills: [
        {
          description: "Use for deployment notes",
          markdown: "# Deployment note\n",
          name: "deploy-note",
        },
      ],
    });
    const source = createBundledRuntimeCompiledArtifactsSource();
    const initialSnapshot = {
      manifest: initial.manifest,
      metadata: createTestCompileMetadata(initial.manifest, "initial"),
      moduleMap: initial.moduleMap,
    };
    const updatedSnapshot = {
      manifest: {
        ...updated.manifest,
        skills: updated.manifest.skills.map(({ files: _files, ...skill }) => skill),
      },
      metadata: createTestCompileMetadata(updated.manifest, "updated"),
      moduleMap: updated.moduleMap,
    };

    const session = createRuntimeSession("redeploy");
    await withRuntimeSession(session, async () => {
      setRuntimeSessionCompiledArtifacts(session, initialSnapshot);
      await expect(
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource: source }),
      ).resolves.toMatchObject({ resolvedAgent: { skills: [] } });

      setRuntimeSessionCompiledArtifacts(session, updatedSnapshot);
      await expect(
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource: source }),
      ).resolves.toMatchObject({ resolvedAgent: { skills: [{ name: "deploy-note" }] } });
    });
  });

  it("keeps resolved bundles for equivalent compiled artifact snapshots", async () => {
    const compiled = await compileFromMemory({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      model: "openai/gpt-5.4",
      name: "test-agent",
    });
    const source = createBundledRuntimeCompiledArtifactsSource();
    const session = createRuntimeSession("workflow-steps");

    await withRuntimeSession(session, async () => {
      setRuntimeSessionCompiledArtifacts(session, {
        ...compiled,
        metadata: createTestCompileMetadata(compiled.manifest, "stable"),
      });
      const firstBundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: source,
      });

      setRuntimeSessionCompiledArtifacts(session, {
        manifest: { ...compiled.manifest },
        metadata: createTestCompileMetadata(compiled.manifest, "stable"),
        moduleMap: { ...compiled.moduleMap },
      });

      await expect(
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource: source }),
      ).resolves.toBe(firstBundle);
    });
  });

  it("invalidates metadata-less compiled artifact replacements", async () => {
    const compiled = await compileFromMemory({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      model: "openai/gpt-5.4",
      name: "test-agent",
    });
    const source = createBundledRuntimeCompiledArtifactsSource();
    const session = createRuntimeSession("metadata-less");

    await withRuntimeSession(session, async () => {
      setRuntimeSessionCompiledArtifacts(session, compiled);
      const firstBundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: source,
      });

      setRuntimeSessionCompiledArtifacts(session, {
        manifest: { ...compiled.manifest },
        moduleMap: { ...compiled.moduleMap },
      });

      await expect(
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource: source }),
      ).resolves.not.toBe(firstBundle);
    });
  });
});

function createTestCompileMetadata(manifest: unknown, moduleMapSource: string) {
  return createCompileMetadata({
    appRoot: "/tmp/app",
    compiledManifestJson: JSON.stringify(manifest),
    diagnosticsArtifactJson: "{}",
    diagnosticsSummary: { errors: 0, warnings: 0 },
    discoveryManifestJson: "{}",
    moduleMapSource,
    paths: resolveCompilerArtifactPaths("/tmp/app"),
  });
}
