import { describe, expect, it } from "vitest";

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
    const updatedSnapshot = {
      manifest: {
        ...updated.manifest,
        skills: updated.manifest.skills.map(({ files: _files, ...skill }) => skill),
      },
      moduleMap: updated.moduleMap,
    };

    const session = createRuntimeSession("redeploy");
    await withRuntimeSession(session, async () => {
      setRuntimeSessionCompiledArtifacts(session, initial);
      await expect(
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource: source }),
      ).resolves.toMatchObject({ resolvedAgent: { skills: [] } });

      setRuntimeSessionCompiledArtifacts(session, updatedSnapshot);
      await expect(
        getCompiledRuntimeAgentBundle({ compiledArtifactsSource: source }),
      ).resolves.toMatchObject({ resolvedAgent: { skills: [{ name: "deploy-note" }] } });
    });
  });
});
