import { describe, expect, it } from "vitest";

import { createCompiledAgentManifest } from "#compiler/manifest.js";
import {
  EMPTY_CHANNEL_ROUTE_PLAN,
  EMPTY_SOURCE_COMPOSITION,
  testCompiledSandbox,
} from "#internal/testing/compiled-node-fixtures.js";
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
    const manifest = createCompiledAgentManifest({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      bindings: {},
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: "openai/gpt-5-mini",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "test-agent",
      },
      sandbox: testCompiledSandbox(),
      sourceComposition: EMPTY_SOURCE_COMPOSITION,
    });

    await withRuntimeSession(createRuntimeSession("outer"), async () => {
      expect(readBundledCompiledArtifacts()).toBeNull();

      const inner = await withBundledCompiledArtifacts(
        {
          manifest,
          moduleMap: {
            nodes: {},
          },
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
