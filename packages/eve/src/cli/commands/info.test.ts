import { describe, expect, test, vi } from "vitest";

import { COMPILE_METADATA_KIND, COMPILE_METADATA_VERSION } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { getApplicationInfo } from "#internal/application/paths.js";
import { inspectApplication } from "#services/inspect-application.js";

import { buildApplicationInfoJson, printApplicationInfo } from "./info.js";

vi.mock("#services/inspect-application.js", () => ({ inspectApplication: vi.fn() }));

const MESSAGING = {
  createSessionRoutePath: "/eve/v1/session",
  sessionMessagesRoutePattern: "/eve/v1/session/:sessionId",
  streamRoutePattern: "/eve/v1/session/:sessionId/stream",
};
const APP_ROOT = "/virtual/app";
const AGENT_ROOT = `${APP_ROOT}/agent`;

async function makeCompiledState(): Promise<CompileAgentResult> {
  const { manifest } = await compileFromMemory({
    agentRoot: AGENT_ROOT,
    appRoot: APP_ROOT,
    model: "openai/gpt-5.4",
    modules: [
      {
        loadNamespace: async () => ({
          default: defineInstructions({ content: "Standing rules.", role: "system" }),
        }),
        logicalPath: "instructions/rules.ts",
      },
      {
        loadNamespace: async () => ({
          default: defineSchedule({ cron: "0 9 * * *", markdown: "Run the digest." }),
        }),
        logicalPath: "schedules/morning-digest.ts",
      },
    ],
    name: "triage-bot",
    tools: [{ description: "Create a triage ticket.", name: "create_ticket" }],
  });
  const digest = { path: "x", sha256: "a".repeat(64) };
  return {
    diagnostics: [],
    manifest,
    metadata: {
      compile: { manifest: digest, moduleMap: digest },
      discovery: {
        diagnostics: digest,
        manifest: digest,
        sourceGraphHash: "a".repeat(64),
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
  test("projects the effective compiled graph into the JSON contract", async () => {
    const json = buildApplicationInfoJson({
      application: getApplicationInfo(APP_ROOT),
      compiledState: await makeCompiledState(),
      messaging: MESSAGING,
    });

    expect(json).toMatchObject({
      diagnostics: { errors: 0, warnings: 0 },
      instructions: "instructions/rules.ts (system)",
      model: "openai/gpt-5.4",
      schedules: ["morning-digest"],
      status: "ready",
    });
    expect(json.tools).toContain("create_ticket");
    expect(json.channels).toContainEqual(
      expect.objectContaining({ method: "GET", urlPath: "/eve/v1/health" }),
    );
    expect(json.messaging.create).toBe("/eve/v1/session");
    expect(json.artifacts?.compiledManifest).toContain("compiled-agent-manifest.json");
  });

  test("reports an unavailable contract when the project is not compiled", () => {
    const json = buildApplicationInfoJson({
      application: getApplicationInfo(APP_ROOT),
      compiledState: null,
      messaging: MESSAGING,
    });

    expect(json).toMatchObject({
      appRoot: APP_ROOT,
      artifacts: null,
      channels: [],
      diagnostics: null,
      model: null,
      status: "unavailable",
      tools: [],
    });
  });
});

describe("printApplicationInfo", () => {
  test("reports the effective compiled tool count", async () => {
    const compiledState = await makeCompiledState();
    vi.mocked(inspectApplication).mockResolvedValue({
      application: getApplicationInfo(APP_ROOT),
      compiledState,
      messaging: MESSAGING,
    });
    const output: string[] = [];

    await printApplicationInfo({ log: (message) => output.push(message) }, APP_ROOT);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(new RegExp(`Tools\\s+${compiledState.manifest.tools.length} tools?`));
  });
});
