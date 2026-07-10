import { describe, expect, it } from "vitest";

import type { CompiledAgentManifest } from "./manifest.js";
import { COMPILED_AGENT_MANIFEST_VERSION, ROOT_COMPILED_AGENT_NODE_ID } from "./manifest.js";
import { collectModuleRefsForManifest, createCompiledModuleMapSource } from "./module-map.js";

function createManifestWithTool(agentRoot: string): CompiledAgentManifest {
  return {
    agentRoot,
    appRoot: agentRoot,
    config: {
      compaction: {},
      model: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.4-mini",
        routing: { kind: "gateway", target: "openai" },
      },
      name: "kitchen-sink-fixture",
    },
    connections: [],
    diagnosticsSummary: {
      errors: 0,
      warnings: 0,
    },
    extensionMounts: [],
    disabledFrameworkTools: [],
    workflowEnabled: false,
    dynamicInstructions: [],
    dynamicSkills: [],
    dynamicTools: [],
    hooks: [],
    kind: "eve-agent-compiled-manifest",
    remoteAgents: [],
    schedules: [],
    sandbox: null,
    sandboxWorkspaces: [],
    skills: [],
    subagentEdges: [],
    channels: [],
    subagents: [],
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
    version: COMPILED_AGENT_MANIFEST_VERSION,
    workspaceResourceRoot: {
      logicalPath: "",
      rootEntries: [],
    },
  };
}

describe("createCompiledModuleMapSource", () => {
  it("emits ESM-safe file URLs for Windows absolute imports", () => {
    const source = createCompiledModuleMapSource({
      importSpecifierStyle: "absolute",
      manifest: createManifestWithTool(
        "G:\\projects\\eve\\apps\\fixtures\\kitchen-sink-fixture\\agent",
      ),
      moduleMapPath:
        "G:\\projects\\eve\\apps\\fixtures\\kitchen-sink-fixture\\.eve\\compile\\module-map.mjs",
    });

    expect(source).toContain(
      'import * as module_0 from "file:///G:/projects/eve/apps/fixtures/kitchen-sink-fixture/agent/tools/echo.ts";',
    );
    expect(source).not.toContain(
      '"G:/projects/eve/apps/fixtures/kitchen-sink-fixture/agent/tools/echo.ts"',
    );
    expect(source).toContain(`"${ROOT_COMPILED_AGENT_NODE_ID}"`);
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
