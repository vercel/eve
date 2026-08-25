import { describe, expect, it } from "vitest";

import type { CompiledAgentManifest, CompiledSandboxDefinition } from "#compiler/manifest.js";
import {
  createCompiledAgentManifest,
  createCompiledAgentResources,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/source-graph.js";
import {
  EMPTY_CHANNEL_ROUTE_PLAN,
  EMPTY_SOURCE_COMPOSITION,
  testCompiledSandbox,
} from "#internal/testing/compiled-node-fixtures.js";
import {
  collectModuleRefsForManifest,
  createCompiledModuleMapSource,
} from "#compiler/module-map.js";

const FRAMEWORK_SANDBOX: CompiledSandboxDefinition = testCompiledSandbox({
  logicalPath: "sandbox.ts",
  sourceId: "eve:sandbox.ts",
});

const FRAMEWORK_SANDBOX_BINDING: CompiledModuleBinding = {
  backing: {
    kind: "programmatic",
    moduleId: "sandbox.ts",
    registryId: "eve",
    revision: "1.0.0-test",
  },
  logicalPath: "sandbox.ts",
  owner: { feature: "sandbox", kind: "framework" },
};

function createManifestWithTool(agentRoot: string): CompiledAgentManifest {
  const separator = agentRoot.includes("\\") ? "\\" : "/";
  return createCompiledAgentManifest({
    agentRoot,
    appRoot: agentRoot,
    bindings: {
      "eve:sandbox.ts": FRAMEWORK_SANDBOX_BINDING,
      "tools/echo.ts": {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: [agentRoot, "tools", "echo.ts"].join(separator),
        },
        logicalPath: "tools/echo.ts",
        owner: { kind: "application" },
      },
    },
    channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
    config: {
      compaction: {},
      model: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.4-mini",
        routing: { kind: "gateway", target: "openai" },
      },
      name: "kitchen-sink-fixture",
    },
    sandbox: FRAMEWORK_SANDBOX,
    sourceComposition: EMPTY_SOURCE_COMPOSITION,
    tools: [
      {
        description: "Echoes input.",
        exportName: "default",
        inputSchema: {},
        logicalPath: "tools/echo.ts",
        name: "echo",
        sourceId: "tools/echo.ts",
        sourceKind: "module",
      },
    ],
  });
}

describe("createCompiledModuleMapSource", () => {
  it("emits ESM-safe file URLs for Windows absolute filesystem bindings", () => {
    const source = createCompiledModuleMapSource({
      importSpecifierStyle: "absolute",
      manifest: createManifestWithTool(
        "G:\\projects\\eve\\apps\\fixtures\\kitchen-sink-fixture\\agent",
      ),
      moduleMapPath:
        "G:\\projects\\eve\\apps\\fixtures\\kitchen-sink-fixture\\.eve\\compile\\module-map.mjs",
    });

    expect(source).toContain(
      'import * as module_1 from "file:///G:/projects/eve/apps/fixtures/kitchen-sink-fixture/agent/tools/echo.ts";',
    );
    expect(source).not.toContain(
      '"G:/projects/eve/apps/fixtures/kitchen-sink-fixture/agent/tools/echo.ts"',
    );
    expect(source).toContain(`"${ROOT_COMPILED_AGENT_NODE_ID}"`);
  });

  it("emits a registry lookup for programmatic bindings", () => {
    const source = createCompiledModuleMapSource({
      manifest: createManifestWithTool("/agent"),
      moduleMapPath: "/agent/.eve/compile/module-map.mjs",
    });

    expect(source).toMatch(
      /import \{ loadFrameworkSourceModuleNamespace as __eveLoadProgrammaticModule \} from ".*internal\/agent-sources(\.js)?";/,
    );
    expect(source).toContain(
      'const module_0 = await __eveLoadProgrammaticModule("eve", "sandbox.ts", "1.0.0-test");',
    );
    expect(source).toContain('"eve:sandbox.ts": module_0');
    expect(source).toContain('"tools/echo.ts": module_1');
  });

  it("imports a dynamic subagent config resolver through its child-scoped binding", () => {
    const manifest: CompiledAgentManifest = {
      ...createManifestWithTool("/agent"),
      subagents: [
        {
          agent: createCompiledAgentResources({
            agentRoot: "/agent/subagents/researcher",
            appRoot: "/agent",
            bindings: {
              "agent.ts": {
                backing: {
                  externalDependencies: [],
                  kind: "filesystem",
                  sourcePath: "/agent/subagents/researcher/agent.ts",
                },
                logicalPath: "agent.ts",
                owner: { kind: "application" },
              },
              "eve:sandbox.ts": FRAMEWORK_SANDBOX_BINDING,
            },
            sandbox: FRAMEWORK_SANDBOX,
            sourceComposition: EMPTY_SOURCE_COMPOSITION,
          }),
          configResolver: {
            eventNames: ["turn.started"],
            logicalPath: "agent.ts",
            sourceId: "agent.ts",
            sourceKind: "module",
          },
          entryPath: "/agent/subagents/researcher/agent.ts",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          rootPath: "/agent/subagents/researcher",
          sourceId: "subagents/researcher",
          sourceKind: "module",
        },
      ],
    };

    const source = createCompiledModuleMapSource({
      manifest,
      moduleMapPath: "/agent/.eve/compile/module-map.mjs",
    });

    expect(source).toContain('from "../../subagents/researcher/agent.ts";');
    expect(source).not.toContain("subagents/researcher/subagents/researcher");
  });
});

describe("collectModuleRefsForManifest", () => {
  it("includes module-sourced schedules with run() so the dispatcher can load the handler", () => {
    const manifest = createManifestWithTool("/agent");
    const manifestWithSchedule: CompiledAgentManifest = {
      ...manifest,
      schedules: [
        {
          cron: "0 9 * * 1-5",
          hasRun: true,
          logicalPath: "schedules/daily-digest.ts",
          name: "daily-digest",
          sourceId: "schedules/daily-digest.ts",
          sourceKind: "module",
        },
      ],
    };

    const refs = collectModuleRefsForManifest(manifestWithSchedule);

    expect(refs).toContainEqual({
      sourceKind: "module",
      logicalPath: "schedules/daily-digest.ts",
      sourceId: "schedules/daily-digest.ts",
    });
  });

  it("omits markdown schedules from the module map", () => {
    const manifest = createManifestWithTool("/agent");
    const manifestWithSchedule: CompiledAgentManifest = {
      ...manifest,
      schedules: [
        {
          cron: "0 0 * * 0",
          hasRun: false,
          logicalPath: "schedules/cleanup.md",
          name: "cleanup",
          owner: { kind: "application" },
          sourceId: "schedules/cleanup.md",
          sourceKind: "markdown",
          markdown: "Clean up stale data.",
        },
      ],
    };

    const refs = collectModuleRefsForManifest(manifestWithSchedule);

    expect(refs.some((ref) => ref.sourceId === "schedules/cleanup.md")).toBe(false);
  });

  it("omits module-sourced schedules that only carry markdown (no run handler)", () => {
    const manifest = createManifestWithTool("/agent");
    const manifestWithSchedule: CompiledAgentManifest = {
      ...manifest,
      schedules: [
        {
          cron: "0 8 * * *",
          hasRun: false,
          logicalPath: "schedules/daily-digest.mjs",
          name: "daily-digest",
          markdown: "Send a weather digest.",
          sourceId: "schedules/daily-digest.mjs",
          sourceKind: "module",
        },
      ],
    };

    const refs = collectModuleRefsForManifest(manifestWithSchedule);

    expect(refs.some((ref) => ref.sourceId === "schedules/daily-digest.mjs")).toBe(false);
  });

  it("includes remote agents from the node manifest without an extra module-ref side channel", () => {
    const manifest = createManifestWithTool("/agent");
    const refs = collectModuleRefsForManifest({
      ...manifest,
      remoteAgents: [
        {
          description: "Answer weather questions remotely.",
          entryPath: "/agent/subagents/weather.ts",
          logicalPath: "subagents/weather.ts",
          name: "weather",
          nodeId: "subagents/weather.ts",
          path: "/eve/v1/session",
          rootPath: "/agent",
          sourceId: "subagents/weather.ts",
          sourceKind: "module",
          url: "https://weather.example.com",
        },
      ],
    });

    expect(refs).toContainEqual({
      sourceKind: "module",
      logicalPath: "subagents/weather.ts",
      sourceId: "subagents/weather.ts",
    });
  });
});
