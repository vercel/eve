import { describe, expect, it } from "vitest";

import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { resolveAgent } from "#runtime/resolve-agent.js";

function createManifest(experimental?: {
  readonly subagentPersistentSessions?: boolean;
  readonly tasks?: boolean;
}) {
  return createCompiledAgentManifest({
    agentRoot: "/app/agent",
    appRoot: "/app",
    config: {
      experimental,
      model: { id: "test-model", routing: { kind: "gateway", target: "test-model" } },
      name: "test-agent",
    },
  });
}

describe("resolveAgent", () => {
  it("normalizes task agents to persistent subagent sessions", async () => {
    const manifest = createManifest({ subagentPersistentSessions: false, tasks: true });

    const agent = await resolveAgent({
      manifest,
      moduleMap: { nodes: { __root__: { modules: {} } } },
    });

    expect(manifest.config.experimental).toEqual({
      subagentPersistentSessions: false,
      tasks: true,
    });
    expect(agent.config?.experimental).toMatchObject({
      subagentPersistentSessions: true,
      tasks: true,
    });
  });

  it.each([
    [undefined, undefined],
    [false, false],
    [true, true],
  ] as const)(
    "preserves authored persistent-session value %s when tasks are disabled",
    async (authored, expected) => {
      const agent = await resolveAgent({
        manifest: createManifest({ subagentPersistentSessions: authored, tasks: false }),
        moduleMap: { nodes: { __root__: { modules: {} } } },
      });

      expect(agent.config?.experimental?.subagentPersistentSessions).toBe(expected);
    },
  );
});
