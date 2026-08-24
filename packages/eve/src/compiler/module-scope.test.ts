import { describe, expect, it } from "vitest";

import { collectCompiledModuleScopes } from "#compiler/module-scope.js";
import {
  createStubCompiledAgentManifest,
  createTestCompiledRemoteAgentNode,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

describe("collectCompiledModuleScopes", () => {
  it("rejects duplicate node scopes before downstream map construction", () => {
    const backing = {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: "/app/agent/subagents/weather.ts",
    };
    const remote = createTestCompiledRemoteAgentNode({
      backing,
      configBinding: {
        backing,
        logicalPath: "subagents/weather.ts",
        owner: { kind: "application" },
      },
      configResolver: {
        logicalPath: "subagents/weather.ts",
        sourceId: "subagents/weather::config",
        sourceKind: "module",
      },
      description: "Answers weather questions.",
      entryPath: backing.sourcePath,
      logicalPath: "subagents/weather",
      name: "weather",
      nodeId: "subagents/weather",
      owner: { kind: "application" },
      path: "/eve/v1/session",
      rootPath: "/app/agent",
      sourceId: "subagents/weather",
      sourceKind: "subagent",
      url: "https://weather.example.com",
    });
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "Module scope test",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      remoteAgents: [remote],
    });

    expect(() =>
      collectCompiledModuleScopes({ ...manifest, remoteAgents: [remote, remote] }),
    ).toThrow('Compiled module scope node id "subagents/weather" is present more than once.');
  });
});
