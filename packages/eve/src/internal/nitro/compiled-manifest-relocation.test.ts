import { describe, expect, it } from "vitest";

import {
  createStubCompiledAgentManifest,
  createTestCompiledRemoteAgentNode,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";
import { relocateCompiledAgentManifest } from "#internal/nitro/compiled-manifest-relocation.js";

describe("relocateCompiledAgentManifest", () => {
  it("relocates declared physical fields without rewriting arbitrary JSON keys", () => {
    const appRoot = "/source/apps/weather";
    const agentRoot = `${appRoot}/agent`;
    const sourcePath = `${agentRoot}/tools/check.ts`;
    const winnerChannelPath = `${agentRoot}/channels/winner.ts`;
    const loserChannelPath = `${agentRoot}/channels/loser.ts`;
    const remoteSourcePath = `${agentRoot}/subagents/reviewer.ts`;
    const shadowedRemoteSourcePath = `${agentRoot}/extensions/reviewer.ts`;
    const opaqueSchemaPath = `${agentRoot}/must-remain-opaque.json`;
    const remoteBase = createTestCompiledRemoteAgentNode({
      backing: { externalDependencies: [], kind: "filesystem", sourcePath: remoteSourcePath },
      configBinding: {
        backing: { externalDependencies: [], kind: "filesystem", sourcePath: remoteSourcePath },
        logicalPath: "subagents/reviewer.ts",
        owner: { kind: "application" },
      },
      configResolver: {
        logicalPath: "subagents/reviewer.ts",
        sourceId: "subagents/reviewer",
        sourceKind: "module",
      },
      description: "Reviews responses.",
      entryPath: remoteSourcePath,
      logicalPath: "subagents/reviewer",
      name: "reviewer",
      nodeId: "subagents/reviewer",
      owner: { kind: "application" },
      path: "/eve/v1/session",
      rootPath: agentRoot,
      sourceId: "subagents/reviewer",
      sourceKind: "subagent",
      url: "https://reviewer.example.com",
    });
    const remote = {
      ...remoteBase,
      sourceComposition: {
        ...remoteBase.sourceComposition,
        shadowed: [
          {
            slot: "subagents/reviewer",
            source: {
              backing: {
                externalDependencies: [],
                kind: "filesystem" as const,
                sourcePath: shadowedRemoteSourcePath,
              },
              layer: "extension-override" as const,
              logicalPath: "subagents/reviewer.ts",
              owner: { kind: "application" as const },
              sourceId: "extensions/reviewer.ts",
              sourceKind: "module" as const,
            },
            winningSourceId: "subagents/reviewer",
          },
        ],
      },
    };
    const manifest = createStubCompiledAgentManifest({
      agentRoot,
      appRoot,
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        {
          binding: {
            backing: { externalDependencies: [], kind: "filesystem", sourcePath },
            owner: { kind: "application" },
          },
          logicalPath: "tools/check.ts",
          sourceId: "tools/check.ts",
        },
        {
          binding: {
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: winnerChannelPath,
            },
            owner: { kind: "application" },
          },
          logicalPath: "channels/winner.ts",
          sourceId: "channels/winner.ts",
        },
        {
          binding: {
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: loserChannelPath,
            },
            owner: { kind: "application" },
          },
          logicalPath: "channels/loser.ts",
          sourceId: "channels/loser.ts",
        },
      ],
      channelRoutes: {
        effective: [
          {
            kind: "channel",
            logicalPath: "channels/winner.ts",
            method: "GET",
            name: "winner",
            sourceId: "channels/winner.ts",
            sourceKind: "module",
            urlPath: "/reviews/:id",
          },
        ],
        preflight: [],
        shadowed: [
          {
            loser: {
              binding: {
                backing: {
                  externalDependencies: [],
                  kind: "filesystem",
                  sourcePath: loserChannelPath,
                },
                logicalPath: "channels/loser.ts",
                owner: { kind: "application" },
              },
              route: {
                kind: "channel",
                logicalPath: "channels/loser.ts",
                method: "GET",
                name: "loser",
                sourceId: "channels/loser.ts",
                sourceKind: "module",
                urlPath: "/reviews/:reviewId",
              },
            },
            method: "GET",
            pathPattern: "/reviews/:_",
            winningSourceId: "channels/winner.ts",
          },
        ],
      },
      config: {
        model: {
          id: "openai/gpt-5.4-mini",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather",
        outputSchema: { sourcePath: opaqueSchemaPath },
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      remoteAgents: [remote],
      tools: [
        {
          description: "Checks the snapshot.",
          inputSchema: { sourcePath: opaqueSchemaPath },
          logicalPath: "tools/check.ts",
          name: "check",
          sourceId: "tools/check.ts",
          sourceKind: "module",
        },
      ],
    });

    const relocated = relocateCompiledAgentManifest(manifest, {
      appPath: (path) => path.replace(appRoot, "/snapshot/app"),
      physicalPath: (path) => path.replace("/source", "/snapshot/source"),
    });

    expect(relocated.appRoot).toBe("/snapshot/app");
    expect(relocated.agentRoot).toBe("/snapshot/app/agent");
    expect(relocated.bindings["tools/check.ts"]?.backing).toMatchObject({
      kind: "filesystem",
      sourcePath: "/snapshot/source/apps/weather/agent/tools/check.ts",
    });
    expect(relocated.channelRoutes.shadowed[0]?.loser.binding.backing).toMatchObject({
      kind: "filesystem",
      sourcePath: "/snapshot/source/apps/weather/agent/channels/loser.ts",
    });
    expect(relocated.remoteAgents[0]).toMatchObject({
      backing: {
        kind: "filesystem",
        sourcePath: "/snapshot/source/apps/weather/agent/subagents/reviewer.ts",
      },
      bindings: {
        "subagents/reviewer": {
          backing: {
            kind: "filesystem",
            sourcePath: "/snapshot/source/apps/weather/agent/subagents/reviewer.ts",
          },
        },
      },
      entryPath: "/snapshot/source/apps/weather/agent/subagents/reviewer.ts",
      rootPath: "/snapshot/source/apps/weather/agent",
      sourceComposition: {
        shadowed: [
          {
            source: {
              backing: {
                kind: "filesystem",
                sourcePath: "/snapshot/source/apps/weather/agent/extensions/reviewer.ts",
              },
            },
          },
        ],
      },
    });
    expect(relocated.config.outputSchema).toEqual({ sourcePath: opaqueSchemaPath });
    expect(relocated.tools[0]?.inputSchema).toEqual({ sourcePath: opaqueSchemaPath });
  });
});
