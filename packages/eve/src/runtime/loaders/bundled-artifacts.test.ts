import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  readBundledCompiledArtifacts,
  withBundledCompiledArtifacts,
} from "#runtime/loaders/bundled-artifacts.js";
import {
  createRuntimeSession,
  getActiveRuntimeSession,
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
});
