import { describe, expect, test } from "vitest";

import { COMPILE_METADATA_KIND, COMPILE_METADATA_VERSION } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { createCompiledAgentManifest, type CompiledChannelEntry } from "#compiler/manifest.js";
import { getApplicationInfo } from "#internal/application/paths.js";

import { buildApplicationInfoJson } from "./info.js";

const MESSAGING = {
  createSessionRoutePath: "/eve/v1/session",
  continueSessionRoutePattern: "/eve/v1/session/:id",
  streamRoutePattern: "/eve/v1/session/:id/stream",
};

const APP_ROOT = "/virtual/app";
const AGENT_ROOT = "/virtual/app/agent";

function makeCompiledState(): CompileAgentResult {
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
        id: "anthropic/claude-sonnet-4.6",
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
      channelInstrumentationTypesPath: `${APP_ROOT}/.eve/compile/channel-instrumentation.d.ts`,
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
    expect(json.model).toBe("anthropic/claude-sonnet-4.6");
    expect(json.tools).toEqual(["create_ticket"]);
    expect(json.skills).toEqual([]);
    expect(json.diagnostics).toEqual({ errors: 0, warnings: 0 });
    expect(json.channels).toEqual([
      { name: "slack", kind: "slack", method: "POST", urlPath: "/eve/v1/slack" },
      { name: "eve", kind: "http", method: "POST", urlPath: "/eve/v1/session" },
    ]);
    expect(json.messaging.create).toBe("/eve/v1/session");
    expect(json.artifacts?.compiledManifest).toContain("compiled-agent-manifest.json");
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
    expect(json.appRoot).toBe(APP_ROOT);
    expect(json.messaging.stream).toBe("/eve/v1/session/:id/stream");
  });
});
