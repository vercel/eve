import { describe, expect, test, vi } from "vitest";

import { COMPILE_METADATA_KIND, COMPILE_METADATA_VERSION } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  type CompiledChannelEntry,
  type CompiledScheduleDefinition,
  type CompiledSubagentNode,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { getApplicationInfo } from "#internal/application/paths.js";
import { inspectApplication } from "#services/inspect-application.js";

import { buildApplicationInfoJson, printApplicationInfo } from "./info.js";

vi.mock("#services/inspect-application.js", () => ({ inspectApplication: vi.fn() }));

const MESSAGING = {
  createSessionRoutePath: "/eve/v1/session",
  continueSessionRoutePattern: "/eve/v1/session/:id",
  streamRoutePattern: "/eve/v1/session/:id/stream",
};

const APP_ROOT = "/virtual/app";
const AGENT_ROOT = "/virtual/app/agent";

function makeSchedule(name: string): CompiledScheduleDefinition {
  return {
    cron: "0 9 * * *",
    hasRun: false,
    logicalPath: `schedules/${name}.md`,
    markdown: `# ${name}`,
    name,
    sourceId: `schedules/${name}.md`,
    sourceKind: "markdown",
  };
}

function makeSubagent(name: string): CompiledSubagentNode {
  return {
    agent: createCompiledAgentNodeManifest({
      agentRoot: `${AGENT_ROOT}/subagents/${name}`,
      appRoot: APP_ROOT,
      config: {
        model: {
          id: "anthropic/claude-sonnet-5",
          routing: { kind: "gateway", target: "anthropic" },
        },
        name,
      },
    }),
    description: `${name} subagent description`,
    entryPath: `subagents/${name}/agent.ts`,
    logicalPath: `subagents/${name}`,
    name,
    nodeId: name,
    rootPath: `subagents/${name}`,
    sourceId: `subagents/${name}/agent.ts`,
    sourceKind: "module",
  };
}

function makeCompiledState(
  options: { subagents?: CompiledSubagentNode[]; schedules?: CompiledScheduleDefinition[] } = {},
): CompileAgentResult {
  const channels: CompiledChannelEntry[] = [
    {
      kind: "channel",
      name: "slack",
      logicalPath: "agent/channels/slack.ts",
      method: "POST",
      urlPath: "/eve/v1/slack",
      sourceId: "memory::slack",
      sourceKind: "module",
      adapterKind: "slack",
    },
    {
      kind: "channel",
      name: "eve",
      logicalPath: "agent/channels/eve.ts",
      method: "POST",
      urlPath: "/eve/v1/session",
      sourceId: "memory::eve",
      sourceKind: "module",
      adapterKind: "http",
    },
  ];
  const manifest = createCompiledAgentManifest({
    agentRoot: AGENT_ROOT,
    appRoot: APP_ROOT,
    config: {
      model: {
        id: "anthropic/claude-sonnet-5",
        routing: { kind: "gateway", target: "anthropic" },
      },
      name: "triage-bot",
    },
    channels,
    tools: [
      {
        description: "Create a triage ticket.",
        inputSchema: null,
        logicalPath: "tools/create_ticket.ts",
        name: "create_ticket",
        sourceId: "memory::create_ticket",
        sourceKind: "module",
      },
    ],
    schedules: options.schedules ?? [],
    subagentEdges: (options.subagents ?? []).map((subagent) => ({
      childNodeId: subagent.nodeId,
      parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    })),
    subagents: options.subagents ?? [],
  });
  const digest = { path: "x", sha256: "y" };
  return {
    diagnostics: [],
    manifest,
    metadata: {
      compile: { moduleMap: digest },
      discovery: {
        diagnostics: digest,
        manifest: digest,
        sourceGraphHash: "hash",
        summary: { errors: 0, warnings: 0 },
      },
      generator: { name: "eve", version: "0.0.0-test" },
      kind: COMPILE_METADATA_KIND,
      status: "ready",
      version: COMPILE_METADATA_VERSION,
    },
    paths: {
      appRoot: APP_ROOT,
      compiledManifestPath: `${APP_ROOT}/.eve/compile/compiled-agent-manifest.json`,
      compileDirectoryPath: `${APP_ROOT}/.eve/compile`,
      compileMetadataPath: `${APP_ROOT}/.eve/compile/compile-metadata.json`,
      diagnosticsPath: `${APP_ROOT}/.eve/discovery/diagnostics.json`,
      discoveryManifestPath: `${APP_ROOT}/.eve/discovery/agent-discovery-manifest.json`,
      discoveryDirectoryPath: `${APP_ROOT}/.eve/discovery`,
      moduleMapPath: `${APP_ROOT}/.eve/compile/module-map.mjs`,
    },
    project: { agentRoot: AGENT_ROOT, appRoot: APP_ROOT, layout: "nested" },
  };
}

describe("buildApplicationInfoJson", () => {
  test("projects a compiled agent into the JSON contract", () => {
    const json = buildApplicationInfoJson({
      application: getApplicationInfo(APP_ROOT),
      compiledState: makeCompiledState(),
      messaging: MESSAGING,
    });

    expect(json.status).toBe("ready");
    expect(json.model).toBe("anthropic/claude-sonnet-5");
    expect(json.tools).toEqual(["create_ticket"]);
    expect(json.skills).toEqual([]);
    expect(json.subagents).toEqual([]);
    expect(json.schedules).toEqual([]);
    expect(json.diagnostics).toEqual({ errors: 0, warnings: 0 });
    expect(json.channels).toEqual([
      { name: "slack", kind: "slack", method: "POST", urlPath: "/eve/v1/slack" },
      { name: "eve", kind: "http", method: "POST", urlPath: "/eve/v1/session" },
    ]);
    expect(json.messaging.create).toBe("/eve/v1/session");
    expect(json.artifacts?.compiledManifest).toContain("compiled-agent-manifest.json");
  });

  test("projects subagents and schedules into the JSON contract when present", () => {
    const json = buildApplicationInfoJson({
      application: getApplicationInfo(APP_ROOT),
      compiledState: makeCompiledState({
        schedules: [makeSchedule("morning-digest"), makeSchedule("weekly-report")],
        subagents: [makeSubagent("research")],
      }),
      messaging: MESSAGING,
    });

    expect(json.subagents).toEqual(["research"]);
    expect(json.schedules).toEqual(["morning-digest", "weekly-report"]);
  });

  test("reports an unavailable contract when the project is not compiled", () => {
    const json = buildApplicationInfoJson({
      application: getApplicationInfo(APP_ROOT),
      compiledState: null,
      messaging: MESSAGING,
    });

    expect(json.status).toBe("unavailable");
    expect(json.model).toBeNull();
    expect(json.instructions).toBeNull();
    expect(json.diagnostics).toBeNull();
    expect(json.artifacts).toBeNull();
    expect(json.channels).toEqual([]);
    expect(json.tools).toEqual([]);
    expect(json.skills).toEqual([]);
    expect(json.subagents).toEqual([]);
    expect(json.schedules).toEqual([]);
    expect(json.appRoot).toBe(APP_ROOT);
    expect(json.messaging.stream).toBe("/eve/v1/session/:id/stream");
  });
});

describe("printApplicationInfo", () => {
  test("includes the authored tool count in text output", async () => {
    vi.mocked(inspectApplication).mockResolvedValue({
      application: getApplicationInfo(APP_ROOT),
      compiledState: makeCompiledState(),
      messaging: MESSAGING,
    });
    const output: string[] = [];

    await printApplicationInfo({ log: (message) => output.push(message) }, APP_ROOT);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/Tools\s+1 tool/);
  });
});
