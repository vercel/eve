import { describe, expect, it } from "vitest";

import {
  shouldPruneConnectionRuntime,
  shouldPruneLocalSandboxBackends,
} from "#internal/nitro/host/create-application-nitro.js";
import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
} from "#compiler/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";

describe("shouldPruneLocalSandboxBackends", () => {
  it("prunes local backends from hosted Vercel builds when the sandbox uses defaultSandbox", () => {
    expect(
      shouldPruneLocalSandboxBackends({
        configuredBackendNames: new Set(),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("keeps local backends when a local backend is configured explicitly", () => {
    for (const backendName of ["docker", "microsandbox", "just-bash"]) {
      expect(
        shouldPruneLocalSandboxBackends({
          configuredBackendNames: new Set([backendName]),
          preset: "vercel",
        }),
      ).toBe(false);
    }
  });

  it("still prunes local backends when only Vercel or custom backends are configured", () => {
    expect(
      shouldPruneLocalSandboxBackends({
        configuredBackendNames: new Set(["vercel", "custom"]),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("does not prune local backends for non-Vercel presets", () => {
    expect(
      shouldPruneLocalSandboxBackends({
        configuredBackendNames: new Set(),
        preset: undefined,
      }),
    ).toBe(false);
  });
});

function createManifest(input: { hasConnection?: boolean; subagentHasConnection?: boolean } = {}) {
  const connection = {
    connectionName: "linear",
    description: "Linear",
    logicalPath: "connections/linear.ts",
    protocol: "mcp" as const,
    sourceId: "connections/linear.ts",
    sourceKind: "module" as const,
    url: "https://mcp.linear.app",
  };
  const config = {
    model: {
      id: "openai/gpt-5.5",
      routing: classifyModelRouting("openai/gpt-5.5"),
    },
    name: "test-agent",
  };
  const subagent = createCompiledAgentNodeManifest({
    agentRoot: "/app/agent/subagents/researcher",
    appRoot: "/app",
    config: { ...config, name: "researcher" },
    connections: input.subagentHasConnection ? [connection] : [],
  });

  return createCompiledAgentManifest({
    agentRoot: "/app/agent",
    appRoot: "/app",
    config,
    connections: input.hasConnection ? [connection] : [],
    subagents: [
      {
        agent: subagent,
        description: "Researches requests.",
        entryPath: "subagents/researcher",
        logicalPath: "subagents/researcher/agent.ts",
        name: "researcher",
        nodeId: "subagents/researcher/agent.ts",
        rootPath: "/app/agent/subagents/researcher",
        sourceId: "subagents/researcher/agent.ts",
        sourceKind: "module",
      },
    ],
  });
}

describe("shouldPruneConnectionRuntime", () => {
  it("prunes connection-only runtime paths from a Vercel build with no connections", () => {
    expect(
      shouldPruneConnectionRuntime({
        manifest: createManifest(),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("keeps connection runtime paths when any local agent node has a connection", () => {
    for (const manifest of [
      createManifest({ hasConnection: true }),
      createManifest({ subagentHasConnection: true }),
    ]) {
      expect(
        shouldPruneConnectionRuntime({
          manifest,
          preset: "vercel",
        }),
      ).toBe(false);
    }
  });

  it("keeps connection runtime paths outside Vercel builds", () => {
    expect(
      shouldPruneConnectionRuntime({
        manifest: createManifest(),
        preset: undefined,
      }),
    ).toBe(false);
  });
});
