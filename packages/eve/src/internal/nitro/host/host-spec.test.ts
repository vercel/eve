import { describe, expect, it } from "vitest";

import { resolveCompilerArtifactPaths } from "#compiler/artifacts.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createHostSpec, type HostMode } from "#internal/nitro/host/host-spec.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/nitro/host/vercel-build-output-config.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { defineChannel, WS } from "#public/definitions/channel.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { attachWorkflowProgramOptions } from "#tools/workflow-program-input.js";

const APP_ROOT = "/tmp/weather-agent";
const DEVELOPMENT: HostMode = { kind: "development" };
const PRODUCTION: HostMode = { kind: "production", preset: undefined };
const VERCEL: HostMode = { kind: "production", preset: "vercel" };

type Modules = Array<NonNullable<Parameters<typeof compileFromMemory>[0]["modules"]>[number]>;

interface AgentVariant {
  readonly externalDependencies?: readonly string[];
  readonly sandbox?: "just-bash" | "vercel";
  readonly tool?: "ordinary" | "workflow" | "workflow-program";
  readonly websocket?: boolean;
}

async function compileAgent(variant: AgentVariant = {}, name = "weather-agent") {
  const agentRoot = `${APP_ROOT}/agent`;
  const modules: Modules = [];
  if (variant.sandbox !== undefined) {
    const provider = variant.sandbox === "just-bash" ? JustBashSandbox : VercelSandbox;
    modules.push({
      logicalPath: "sandbox.ts",
      loadNamespace: async () => {
        const environment = provider.environment();
        return { environment, default: defineSandbox(() => environment.open()) };
      },
    });
  }
  if (variant.websocket === true) {
    modules.push({
      logicalPath: "channels/voice.ts",
      loadNamespace: async () => ({
        default: defineChannel({ routes: [WS("/eve/v1/voice/ws", async () => ({ open() {} }))] }),
      }),
    });
  }
  if (variant.tool === "ordinary") {
    modules.push({
      logicalPath: "tools/weather.ts",
      loadNamespace: async () => ({
        default: defineTool({
          description: "Check the weather.",
          execute: async () => null,
          inputSchema: {},
        }),
      }),
    });
  }
  if (variant.tool === "workflow" || variant.tool === "workflow-program") {
    const definition = defineWorkflowTool({
      description: "Run a workflow.",
      execute: Object.assign(async () => null, {
        workflowId: "workflow//agent/tools/run-program//execute",
      }),
      inputSchema: {},
    });
    const tool =
      variant.tool === "workflow-program"
        ? attachWorkflowProgramOptions(definition, { maxSubagents: 4 })
        : definition;
    modules.push({
      logicalPath: "tools/run-program.ts",
      loadNamespace: async () => ({ default: tool }),
    });
  }
  const { manifest } = await compileFromMemory({
    agentRoot,
    appRoot: APP_ROOT,
    agent: {
      model: "openai/gpt-5.4",
      ...(variant.externalDependencies && {
        build: { externalDependencies: [...variant.externalDependencies] },
      }),
    },
    model: "openai/gpt-5.4",
    modules,
    name,
  });
  return manifest;
}

/** Adds `child` as an application subagent of `root`. */
function withSubagent(root: CompiledAgentManifest, child: CompiledAgentManifest) {
  const { kind: _kind, subagents: _subagents, version: _version, ...agent } = child;
  root.subagents = [
    {
      agent,
      backing: { kind: "resource", sourcePath: `${APP_ROOT}/agent/subagents/researcher` },
      description: "Researches questions.",
      entryPath: "subagents/researcher",
      logicalPath: "subagents/researcher/agent.ts",
      name: "researcher",
      nodeId: "root:subagents/researcher",
      owner: { kind: "application" },
      parentNodeId: "__root__",
      rootPath: `${APP_ROOT}/agent/subagents/researcher`,
      sourceId: "subagents/researcher/agent.ts",
      sourceKind: "module",
    },
  ];
  return root;
}

function spec(
  manifest: CompiledAgentManifest,
  mode: HostMode,
  options: { readonly instrumented?: boolean } = {},
) {
  const host: PreparedApplicationHost = {
    appRoot: APP_ROOT,
    compileResult: {
      manifest,
      paths: resolveCompilerArtifactPaths(APP_ROOT),
    } as PreparedApplicationHost["compileResult"],
    compiledArtifacts: {
      bootstrapPath: `${APP_ROOT}/.eve/bootstrap.mjs`,
      workflowWorldPluginPath: `${APP_ROOT}/.eve/workflow-world.mjs`,
      ...(options.instrumented === true && {
        instrumentationPluginPath: `${APP_ROOT}/.eve/instrumentation.mjs`,
      }),
    },
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: `${APP_ROOT}/.eve/workflow`,
  };
  return createHostSpec(host, mode, {
    buildDir: `${APP_ROOT}/.eve/nitro`,
    outputDir: `${APP_ROOT}/.output`,
  });
}

describe("createHostSpec", () => {
  it("loads local tracing and compiled artifacts before the Workflow world in dev", async () => {
    expect(spec(await compileAgent(), DEVELOPMENT).runtimePlugins).toEqual([
      "local-tracing",
      "compiled-artifacts",
      "workflow-world",
    ]);
  });

  it("lets authored instrumentation replace local tracing and wrap the server entry", async () => {
    for (const mode of [DEVELOPMENT, PRODUCTION]) {
      const instrumented = spec(await compileAgent(), mode, { instrumented: true });
      expect(instrumented.instrumented).toBe(true);
      expect(instrumented.runtimePlugins).toContain("instrumentation");
      expect(instrumented.runtimePlugins).not.toContain("local-tracing");
    }
  });

  it("adds sandbox shutdown and development-runtime pruning only to production hosts", async () => {
    const manifest = await compileAgent();
    const production = spec(manifest, PRODUCTION);
    const development = spec(manifest, DEVELOPMENT);

    expect(production.runtimePlugins).toEqual([
      "compiled-artifacts",
      "workflow-world",
      "sandbox-shutdown",
    ]);
    expect(production.externals.pruneDevelopmentRuntime).toBe(true);
    expect(development.runtimePlugins).not.toContain("sandbox-shutdown");
    expect(development.externals.pruneDevelopmentRuntime).toBe(false);
  });

  it.each([
    ["an ordinary tool", "ordinary", false],
    ["a workflow tool", "workflow", false],
    ["a generated-program tool", "workflow-program", true],
  ] as const)(
    "installs the workflow sandbox runtime for %s: %s",
    async (_label, tool, expected) => {
      const plugins = spec(await compileAgent({ tool }), PRODUCTION).runtimePlugins;
      expect(plugins.includes("workflow-sandbox")).toBe(expected);
    },
  );

  it("installs the workflow sandbox runtime for a subagent's generated-program tool", async () => {
    const manifest = withSubagent(
      await compileAgent(),
      await compileAgent({ tool: "workflow-program" }, "researcher"),
    );
    expect(spec(manifest, PRODUCTION).runtimePlugins).toContain("workflow-sandbox");
  });

  it.each([
    ["Vercel without a sandbox", VERCEL, undefined, true],
    ["Vercel with Vercel Sandbox", VERCEL, "vercel", true],
    ["Vercel with just-bash", VERCEL, "just-bash", false],
    ["a self-hosted build", PRODUCTION, undefined, false],
    ["dev", DEVELOPMENT, undefined, false],
  ] as const)(
    "prunes local sandbox providers from %s: %s",
    async (_label, mode, sandbox, expected) => {
      const externals = spec(await compileAgent({ sandbox }), mode).externals;
      expect(externals.pruneSandboxProviders).toBe(expected);
    },
  );

  it("traces a configured optional engine and keeps unconfigured ones external and untraced", async () => {
    const configured = spec(await compileAgent({ sandbox: "just-bash" }), PRODUCTION).externals;
    const unconfigured = spec(await compileAgent(), PRODUCTION).externals;

    expect(configured.traceDeps).toEqual(["just-bash"]);
    expect(configured.untracedExternals).toEqual([]);
    expect(unconfigured.traceDeps).toEqual([]);
    expect(unconfigured.untracedExternals).toEqual(["just-bash"]);
  });

  it("traces configured externals from root and subagent configs once in production, never eve itself", async () => {
    const manifest = withSubagent(
      await compileAgent({ externalDependencies: ["fixture-external", "sharp", "sharp", "eve"] }),
      await compileAgent({ externalDependencies: ["subagent-external", "sharp"] }, "researcher"),
    );
    const externals = spec(manifest, PRODUCTION).externals;

    expect(externals.traceDeps).toEqual(["fixture-external", "sharp", "subagent-external"]);
    expect(externals.checkedExternals).toEqual(
      expect.arrayContaining(["fixture-external", "sharp", "subagent-external"]),
    );
    // Nitro externalizes without tracing in dev.
    expect(spec(manifest, DEVELOPMENT).externals).toMatchObject({
      checkedExternals: [],
      traceDeps: [],
    });
  });

  it("enables WebSocket support in dev and for production hosts that declare a WebSocket route", async () => {
    const plain = await compileAgent();
    expect(spec(plain, DEVELOPMENT).websocket).toBe(true);
    expect(spec(plain, VERCEL).websocket).toBe(false);
    expect(spec(await compileAgent({ websocket: true }), VERCEL).websocket).toBe(true);
  });

  it("configures Vercel build output, including the queue-triggered flow function, only on Vercel", async () => {
    const manifest = await compileAgent();
    const vercel = spec(manifest, VERCEL);

    expect(vercel.preset).toBe("vercel");
    expect(vercel.vercel?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH]).toMatchObject({
      experimentalTriggers: [expect.objectContaining({ type: "queue/v2beta" })],
      maxDuration: "max",
    });
    expect(spec(manifest, PRODUCTION).vercel).toBeUndefined();
    expect(spec(manifest, DEVELOPMENT).vercel).toBeUndefined();
  });
});
