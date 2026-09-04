import { describe, expect, it, vi } from "vitest";

import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "#discover/manifest.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  type ProgrammaticAgentModule,
} from "#compiler/source-graph.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import type { CompilerDiagnostic } from "#compiler/diagnostics.js";
import { createProgrammaticCompiledModuleMap } from "#compiler/module-map.js";
import { validateCompiledModuleMap } from "#compiler/validate-artifact.js";
import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineChannel, GET, POST } from "#public/definitions/channel.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { defineSkill } from "#public/definitions/skill.js";
import { resolveAgent } from "#runtime/resolve-agent.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { compiledAgentManifestSchema } from "#compiler/manifest.js";
import { defineTool, disableTool } from "#tools/definition.js";
import { defineMemory } from "#public/memory/index.js";
import { defineDynamic } from "#dynamic/definition.js";
import { experimental_workflow } from "#tools/workflow.js";
import { webSearch } from "#tools/provided/web-search.js";

function manifest() {
  return createAgentSourceManifest({
    agentId: "source-test",
    agentRoot: "/virtual/source-test/agent",
    appRoot: "/virtual/source-test",
  });
}

function registry(modules: readonly ProgrammaticAgentModule[]) {
  return createAgentSourceRegistry([
    {
      applyTo: "root",
      source: defineProgrammaticAgentSource({
        id: "test:application",
        modules,
        revision: "test:application:v1",
      }),
    },
  ]);
}

describe("compileAgentManifest source graph", () => {
  it("freezes source metadata behind an immutable registry map", () => {
    const sourceRegistry = registry([]);

    expect(Object.isFrozen(sourceRegistry)).toBe(true);
    expect(Object.isFrozen(sourceRegistry.registrations)).toBe(true);
    expect("set" in sourceRegistry.sources).toBe(false);
  });

  it("selects authored config and ordinary tools through one programmatic source", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => ({
          default: defineAgent({
            model: "openai/gpt-5.4",
          }),
        }),
      },
      {
        logicalPath: "tools/weather.ts",
        loadNamespace: async () => ({
          default: defineTool({
            description: "Gets weather.",
            execute: () => ({ ok: true }),
            inputSchema: { type: "object" },
          }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });

    const weather = compiled.tools.find((tool) => tool.name === "weather");
    expect(compiled.config.source.logicalPath).toBe("agent.ts");
    expect(compiled.bindings[compiled.config.source.sourceId]?.owner).toEqual({
      kind: "application",
    });
    expect(weather).toMatchObject({
      hasExecute: true,
      logicalPath: "tools/weather.ts",
      name: "weather",
    });
    expect(compiled.sourceComposition.entries).toContainEqual(
      expect.objectContaining({
        kind: "shadowed",
        source: expect.objectContaining({
          logicalPath: "agent.ts",
          owner: expect.objectContaining({ kind: "framework" }),
        }),
      }),
    );

    const moduleMap = await createProgrammaticCompiledModuleMap(compiled, [
      frameworkAgentSourceRegistry,
      sourceRegistry,
    ]);
    expect(() => validateCompiledModuleMap(compiled, moduleMap)).not.toThrow();
  });

  it("derives workflow handling from programmatic executor metadata", async () => {
    const execute = async () => ({ ok: true });
    Reflect.set(execute, "workflowId", "workflow//example/tool//execute");
    const sourceRegistry = registry([
      {
        logicalPath: "tools/durable.ts",
        loadNamespace: async () => ({
          default: defineTool({
            description: "Runs durably.",
            execute,
            inputSchema: { type: "object" },
          }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });

    expect(compiled.tools.find((tool) => tool.name === "durable")?.behavior).toEqual({
      availability: [],
      handling: {
        kind: "workflow-tool",
        workflowId: "workflow//example/tool//execute",
      },
      shape: { lifetime: "step", suspend: "workflow" },
    });
  });

  it("preserves selected native behavior through serialization and runtime preparation", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "tools/web_search.ts",
        loadNamespace: async () => ({ default: webSearch({ provider: "parallel" }) }),
      },
    ]);
    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });
    const serialized = compiledAgentManifestSchema.parse(JSON.parse(JSON.stringify(compiled)));
    const moduleMap = await createProgrammaticCompiledModuleMap(serialized, [
      frameworkAgentSourceRegistry,
      sourceRegistry,
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest: serialized, moduleMap });

    expect(serialized.tools.find((tool) => tool.name === "agent")).toMatchObject({
      hasExecute: true,
    });
    expect(serialized.tools.find((tool) => tool.name === "ask_question")).toMatchObject({
      behavior: {
        availability: ["requires-request-input"],
        handling: { kind: "request-input", request: "question" },
      },
      hasExecute: false,
    });
    expect(serialized.tools.find((tool) => tool.name === "web_search")).toMatchObject({
      behavior: {
        availability: [],
        handling: { kind: "provider-tool", provider: "parallel" },
      },
      hasExecute: false,
    });
    expect(graph.root.turnAgent.tools.find((tool) => tool.name === "agent")).toMatchObject({
      rootOnly: true,
      task: {
        nodeId: "__root__",
        resultKind: "subagent",
        workflowId: expect.stringContaining("subagentToolExecuteWorkflow"),
      },
    });
    expect(graph.root.turnAgent.tools.find((tool) => tool.name === "web_search")).toMatchObject({
      behavior: {
        handling: { kind: "provider-tool", provider: "parallel" },
      },
    });
  });

  it("keeps an authored framework-slot replacement as an ordinary executable tool", async () => {
    const execute = vi.fn(() => ({ ordinary: true }));
    const sourceRegistry = registry([
      {
        logicalPath: "tools/agent.ts",
        loadNamespace: async () => ({
          default: defineTool({ description: "Application agent tool.", execute, inputSchema: {} }),
        }),
      },
    ]);
    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });
    const selected = compiled.tools.find((tool) => tool.name === "agent");
    expect(selected).toMatchObject({ hasExecute: true, logicalPath: "tools/agent.ts" });
    expect(selected?.behavior).toEqual({
      availability: [],
      shape: { lifetime: "step", suspend: "none" },
    });

    const moduleMap = await createProgrammaticCompiledModuleMap(compiled, [
      frameworkAgentSourceRegistry,
      sourceRegistry,
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest: compiled, moduleMap });
    const resolved = graph.root.toolRegistry.toolsByName.get("agent")?.definition;
    expect(resolved?.behavior).toEqual({
      availability: [],
      shape: { lifetime: "step", suspend: "none" },
    });
    expect(await resolved?.execute?.({}, {} as never)).toEqual({ ordinary: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("loads the selected config before any non-config definition", async () => {
    const order: string[] = [];
    const sourceRegistry = registry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => {
          order.push("config");
          return { default: defineAgent({ model: "openai/gpt-5.4" }) };
        },
      },
      {
        logicalPath: "tools/probe.ts",
        loadNamespace: async () => {
          order.push("tool");
          return {
            default: defineTool({ description: "Probe.", inputSchema: {}, execute: () => null }),
          };
        },
      },
    ]);

    await compileAgentManifest(manifest(), { sourceRegistries: [sourceRegistry] });

    expect(order[0]).toBe("config");
    expect(order).toContain("tool");
  });

  it("classifies compile and runtime usage from normalized authored semantics", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => ({
          default: defineAgent({ model: "openai/gpt-5.4" }),
        }),
      },
      {
        logicalPath: "instructions/static.ts",
        loadNamespace: async () => ({
          default: defineInstructions({ content: "Static instructions." }),
        }),
      },
      {
        logicalPath: "instructions/dynamic.ts",
        loadNamespace: async () => ({
          default: defineDynamic({
            events: { "session.started": () => ({ content: "Dynamic instructions." }) },
          }),
        }),
      },
      {
        logicalPath: "skills/static.ts",
        loadNamespace: async () => ({
          default: defineSkill({ description: "Static skill.", markdown: "# Static\n" }),
        }),
      },
      {
        logicalPath: "skills/dynamic.ts",
        loadNamespace: async () => ({
          default: defineDynamic({
            events: {
              "session.started": () =>
                defineSkill({ description: "Dynamic skill.", markdown: "# Dynamic\n" }),
            },
          }),
        }),
      },
      {
        logicalPath: "schedules/prompt.ts",
        loadNamespace: async () => ({
          default: defineSchedule({ cron: "0 9 * * *", markdown: "Run the prompt." }),
        }),
      },
      {
        logicalPath: "schedules/handler.ts",
        loadNamespace: async () => ({
          default: defineSchedule({ cron: "0 10 * * *", run: async () => {} }),
        }),
      },
      {
        logicalPath: "tools/executable.ts",
        loadNamespace: async () => ({
          default: defineTool({ description: "Execute.", execute: () => null, inputSchema: {} }),
        }),
      },
      {
        logicalPath: "tools/dynamic.ts",
        loadNamespace: async () => ({
          default: defineDynamic({
            events: {
              "session.started": () =>
                defineTool({ description: "Dynamic.", execute: () => null, inputSchema: {} }),
            },
          }),
        }),
      },
      {
        logicalPath: "tools/workflow.ts",
        loadNamespace: async () => ({ default: experimental_workflow() }),
      },
      {
        logicalPath: "tools/web_search.ts",
        loadNamespace: async () => ({ default: webSearch({ provider: "parallel" }) }),
      },
      {
        logicalPath: "connections/linear.ts",
        loadNamespace: async () => ({
          default: defineMcpClientConnection({
            description: "Linear.",
            url: "https://mcp.linear.example",
          }),
        }),
      },
      {
        logicalPath: "connections/accounts.ts",
        loadNamespace: async () => ({
          default: defineDynamic({
            events: {
              "turn.started": () =>
                defineMcpClientConnection({
                  description: "Caller account.",
                  url: "https://mcp.accounts.example",
                }),
            },
          }),
        }),
      },
      {
        logicalPath: "hooks/audit.ts",
        loadNamespace: async () => ({
          default: defineHook({ events: { "session.started": async () => {} } }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });
    const usageByLogicalPath = Object.fromEntries(
      Object.values(compiled.bindings).map((binding) => [binding.logicalPath, binding.usage]),
    );

    expect(compiled.dynamicConnections).toContainEqual(
      expect.objectContaining({
        eventNames: ["turn.started"],
        logicalPath: "connections/accounts.ts",
        slug: "accounts",
      }),
    );
    expect(usageByLogicalPath).toMatchObject({
      "agent.ts": { compile: true, runtimeEntry: false },
      "connections/accounts.ts": { compile: true, runtimeEntry: true },
      "connections/linear.ts": { compile: true, runtimeEntry: true },
      "hooks/audit.ts": { compile: true, runtimeEntry: true },
      "instructions/dynamic.ts": { compile: true, runtimeEntry: true },
      "instructions/static.ts": { compile: true, runtimeEntry: false },
      "schedules/handler.ts": { compile: true, runtimeEntry: true },
      "schedules/prompt.ts": { compile: true, runtimeEntry: false },
      "skills/dynamic.ts": { compile: true, runtimeEntry: true },
      "skills/static.ts": { compile: true, runtimeEntry: false },
      "tools/dynamic.ts": { compile: true, runtimeEntry: true },
      "tools/executable.ts": { compile: true, runtimeEntry: true },
      "tools/web_search.ts": { compile: true, runtimeEntry: false },
      "tools/workflow.ts": { compile: true, runtimeEntry: false },
    });
  });

  it("rejects step-scoped dynamic connections", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => ({
          default: defineAgent({ model: "openai/gpt-5.4" }),
        }),
      },
      {
        logicalPath: "connections/accounts.ts",
        loadNamespace: async () => ({
          default: defineDynamic({
            events: {
              "step.started": () =>
                defineMcpClientConnection({
                  description: "Caller account.",
                  url: "https://mcp.accounts.example",
                }),
            },
          }),
        }),
      },
    ]);

    await expect(
      compileAgentManifest(manifest(), { sourceRegistries: [sourceRegistry] }),
    ).rejects.toThrow(
      'Dynamic connections support only "session.started" and "turn.started" handlers.',
    );
  });

  it("projects the root node once and finalizes its filesystem bindings after config", async () => {
    let toolSourceIterations = 0;
    const discovered = manifest();
    discovered.instrumentation = createModuleSourceRef({ logicalPath: "instrumentation.ts" });
    discovered.tools = new Proxy(discovered.tools, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) toolSourceIterations += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const sourceRegistry = registry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => ({
          default: defineAgent({
            build: { externalDependencies: ["sharp"] },
            model: "openai/gpt-5.4",
          }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(discovered, {
      sourceRegistries: [sourceRegistry],
    });

    expect(toolSourceIterations).toBe(1);
    expect(compiled.bindings["instrumentation.ts"]?.backing).toMatchObject({
      externalDependencies: ["sharp"],
      kind: "filesystem",
    });
    expect(compiled.bindings["instrumentation.ts"]?.usage).toEqual({
      compile: false,
      runtimeEntry: true,
    });
  });

  it("classifies dynamic and source-backed model configs as runtime entries", async () => {
    const dynamicRegistry = registry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => ({
          default: defineAgent({
            model: defineDynamic({
              events: { "session.started": () => "openai/gpt-5.4" },
            }),
          }),
        }),
      },
    ]);
    const dynamic = await compileAgentManifest(manifest(), {
      sourceRegistries: [dynamicRegistry],
    });
    expect(dynamic.bindings[dynamic.config.source.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: true,
    });

    const directModel = {
      doGenerate: async () => ({}),
      doStream: async () => ({}),
      modelId: "direct-model",
      provider: "test-provider",
      specificationVersion: "v3",
    } as never;
    const directRegistry = registry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => ({
          default: defineAgent({ model: directModel, modelContextWindowTokens: 8_192 }),
        }),
      },
    ]);
    const direct = await compileAgentManifest(manifest(), {
      sourceRegistries: [directRegistry],
    });
    expect(direct.config.model?.source?.sourceId).toBe(direct.config.source.sourceId);
    expect(direct.bindings[direct.config.source.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: true,
    });
  });

  it("classifies extension mount initialization as runtime-only", async () => {
    const discovered = manifest();
    const extensionManifest = createAgentSourceManifest({
      agentId: "crm-extension",
      agentRoot: "/virtual/crm-extension/extension",
      appRoot: "/virtual/crm-extension",
    });
    discovered.extensions.push(createModuleSourceRef({ logicalPath: "extensions/crm.ts" }));
    discovered.resolvedExtensions.push({
      externalDependencies: [],
      manifest: extensionManifest,
      namespace: "crm",
      packageName: "@acme/crm",
      packageRoot: "/virtual/crm-extension",
      sourceRoot: extensionManifest.agentRoot,
      specifier: "@acme/crm/extension",
    });
    const sourceRegistry = registry([
      {
        logicalPath: "agent.ts",
        loadNamespace: async () => ({
          default: defineAgent({ model: "openai/gpt-5.4" }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(discovered, {
      sourceRegistries: [sourceRegistry],
    });
    const mount = compiled.extensionMounts[0]!;

    expect(compiled.bindings[mount.mountSourceId]?.usage).toEqual({
      compile: false,
      runtimeEntry: true,
    });
  });

  it("projects a local subagent node once", async () => {
    let toolSourceIterations = 0;
    const child = createAgentSourceManifest({
      agentId: "child",
      agentRoot: "/virtual/source-test/agent/subagents/child",
      appRoot: "/virtual/source-test",
    });
    child.tools = new Proxy(child.tools, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) toolSourceIterations += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const discovered = manifest();
    discovered.subagents.push(
      createLocalSubagentSourceRef({
        entryPath: child.agentRoot,
        logicalPath: "subagents/child",
        manifest: child,
        rootPath: child.agentRoot,
        subagentId: "child",
      }),
    );

    await expect(
      compileAgentManifest(discovered, {
        sourceRegistries: [
          registry([
            {
              logicalPath: "agent.ts",
              loadNamespace: async () => ({
                default: defineAgent({ model: "openai/gpt-5.4" }),
              }),
            },
          ]),
        ],
      }),
    ).rejects.toThrow('Subagent "subagents/child" must define a non-empty description.');

    expect(toolSourceIterations).toBe(1);
  });

  it("disables a lower-precedence framework slot without retaining a binding", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "tools/bash.ts",
        loadNamespace: async () => ({ default: disableTool() }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });
    const disabled = compiled.sourceComposition.entries.find(
      (entry) => entry.kind === "disabled" && entry.source.logicalPath === "tools/bash.ts",
    );

    expect(compiled.tools.some((tool) => tool.name === "bash")).toBe(false);
    expect(disabled).toBeDefined();
    expect(compiled.bindings[disabled!.source.sourceId]).toBeUndefined();
  });

  it("retains concrete route shadows and appends compiler diagnostics", async () => {
    const diagnostics: CompilerDiagnostic[] = [];
    const sourceRegistry = registry([
      {
        logicalPath: "channels/first.ts",
        loadNamespace: async () => ({
          default: defineChannel({ routes: [GET("/same/:id", async () => new Response("first"))] }),
        }),
      },
      {
        logicalPath: "channels/second.ts",
        loadNamespace: async () => ({
          default: defineChannel({
            routes: [GET("/same/[name]", async () => new Response("second"))],
          }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      diagnostics,
      sourceRegistries: [sourceRegistry],
    });

    expect(compiled.channelRoutes.shadowed).toHaveLength(1);
    expect(compiled.channelRoutes.shadowed[0]).toMatchObject({
      method: "GET",
      source: {
        layer: "application",
        logicalPath: "channels/second.ts",
        owner: { kind: "application" },
      },
      urlPath: "/same/[name]",
    });
    expect(compiled.bindings[compiled.channelRoutes.effective[0]!.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: true,
    });
    expect(compiled.bindings[compiled.channelRoutes.shadowed[0]!.source.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: false,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "compile/channel-route-shadowed", severity: "warning" }),
    );
    expect(compiled.diagnosticsSummary.warnings).toBe(1);
  });

  it("rejects duplicate routes emitted by one selected channel", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "channels/duplicate.ts",
        loadNamespace: async () => ({
          default: defineChannel({
            routes: [
              GET("/duplicate/:id", async () => new Response()),
              GET("/duplicate/[name]", async () => new Response()),
            ],
          }),
        }),
      },
    ]);

    await expect(
      compileAgentManifest(manifest(), { sourceRegistries: [sourceRegistry] }),
    ).rejects.toThrow("compile/channel-route-duplicate");
  });

  it("rejects conflicting CORS policies across overlapping route patterns", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "channels/accounts-read.ts",
        loadNamespace: async () => ({
          default: defineChannel({
            cors: { origin: ["https://read.example.com"] },
            routes: [GET("/accounts/:id", async () => new Response())],
          }),
        }),
      },
      {
        logicalPath: "channels/accounts-write.ts",
        loadNamespace: async () => ({
          default: defineChannel({
            cors: { origin: ["https://write.example.com"] },
            routes: [POST("/accounts/me", async () => new Response())],
          }),
        }),
      },
    ]);

    await expect(
      compileAgentManifest(manifest(), { sourceRegistries: [sourceRegistry] }),
    ).rejects.toThrow("compile/channel-cors-conflict");
  });

  it("allows identical CORS policies across overlapping route patterns", async () => {
    const cors = { origin: ["https://app.example.com"] } as const;
    const sourceRegistry = registry([
      {
        logicalPath: "channels/accounts-read.ts",
        loadNamespace: async () => ({
          default: defineChannel({
            cors,
            routes: [GET("/accounts/:id", async () => new Response())],
          }),
        }),
      },
      {
        logicalPath: "channels/accounts-write.ts",
        loadNamespace: async () => ({
          default: defineChannel({
            cors,
            routes: [POST("/accounts/me", async () => new Response())],
          }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), { sourceRegistries: [sourceRegistry] });

    expect(compiled.channelRoutes.preflight).toHaveLength(2);
  });

  it("loads programmatic hooks and persists exact event subscriptions", async () => {
    const sourceRegistry = registry([
      {
        exportName: "audit",
        logicalPath: "hooks/auth/guard.ts",
        loadNamespace: async () => ({
          audit: defineHook({
            events: {
              "session.started": async () => {},
              "step.started": async () => {},
            },
          }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });

    expect(compiled.hooks).toContainEqual({
      eventNames: ["session.started", "step.started"],
      exportName: "audit",
      logicalPath: "hooks/auth/guard.ts",
      slug: "auth/guard",
      sourceId: "test:application:hooks/auth/guard.ts",
      sourceKind: "module",
    });
  });

  it("compiles a selected memory and its provider-tool wrapper through total bindings", async () => {
    const definitionFactory = vi.fn(() =>
      defineMemory({
        description: "Manage the caller profile.",
        provider: {
          recall: {
            "turn.started": async () => ({
              messages: [{ content: "Likes tea", id: "drink" }],
            }),
          },
          tools: async () => ({
            save: defineTool({
              description: "Save a profile field.",
              execute: async () => ({ saved: true }),
              inputSchema: { type: "object" },
            }),
          }),
        },
        scope: "user_1",
      }),
    );
    const sourceRegistry = registry([
      {
        logicalPath: "memory/profile.ts",
        loadNamespace: async () => ({
          default: definitionFactory,
        }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });
    const memory = compiled.memories[0]!;
    const wrapper = compiled.dynamicTools.find((tool) => tool.slug === "profile")!;
    expect(definitionFactory).toHaveBeenCalledTimes(1);

    expect(memory).toMatchObject({
      description: "Manage the caller profile.",
      logicalPath: "memory/profile.ts",
      slot: "profile",
      visibility: "scope",
    });
    expect(wrapper).toMatchObject({
      eventNames: ["turn.started"],
      logicalPath: "tools/profile.ts",
      rebindMissingCallbacks: true,
    });
    expect(compiled.bindings[wrapper.sourceId]?.backing).toMatchObject({
      dependencies: { memory: memory.sourceId },
      kind: "programmatic",
      parameters: {
        memoryExportName: "default",
        memoryLogicalPath: "memory/profile.ts",
        slot: "profile",
      },
    });
    expect(compiled.bindings[memory.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: true,
    });
    expect(compiled.bindings[wrapper.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: true,
    });

    const moduleMap = await createProgrammaticCompiledModuleMap(compiled, [
      frameworkAgentSourceRegistry,
      sourceRegistry,
    ]);
    expect(() => validateCompiledModuleMap(compiled, moduleMap)).not.toThrow();
    expect(moduleMap.nodes.__root__?.modules[memory.sourceId]).toBeDefined();
    expect(moduleMap.nodes.__root__?.modules[wrapper.sourceId]).toBeDefined();
    expect(definitionFactory).toHaveBeenCalledTimes(2);

    const resolved = await resolveAgent({ manifest: compiled, moduleMap });
    expect(resolved.memories).toHaveLength(1);
    expect(definitionFactory).toHaveBeenCalledTimes(2);
  });

  it("lets an application tool replace the derived provider-tool wrapper", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "memory/profile.ts",
        loadNamespace: async () => ({
          default: defineMemory({
            provider: { recall: { "turn.started": async () => null } },
            scope: "user_1",
          }),
        }),
      },
      {
        logicalPath: "tools/profile.ts",
        loadNamespace: async () => ({
          default: defineTool({
            description: "Application-owned profile tool.",
            execute: async () => null,
            inputSchema: {},
          }),
        }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });

    expect(compiled.memories).toHaveLength(1);
    expect(compiled.dynamicTools).not.toContainEqual(expect.objectContaining({ slug: "profile" }));
    expect(compiled.tools).toContainEqual(
      expect.objectContaining({
        description: "Application-owned profile tool.",
        logicalPath: "tools/profile.ts",
        name: "profile",
      }),
    );
    expect(compiled.sourceComposition.entries).toContainEqual(
      expect.objectContaining({
        kind: "shadowed",
        source: expect.objectContaining({
          logicalPath: "tools/profile.ts",
          owner: { feature: "memory", kind: "framework" },
        }),
      }),
    );
  });

  it("lets an application disable the derived provider-tool wrapper", async () => {
    const sourceRegistry = registry([
      {
        logicalPath: "memory/profile.ts",
        loadNamespace: async () => ({
          default: defineMemory({
            provider: { recall: { "turn.started": async () => null } },
            scope: "user_1",
          }),
        }),
      },
      {
        logicalPath: "tools/profile.ts",
        loadNamespace: async () => ({ default: disableTool() }),
      },
    ]);

    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });

    expect(compiled.memories).toHaveLength(1);
    expect(compiled.dynamicTools).not.toContainEqual(expect.objectContaining({ slug: "profile" }));
    expect(compiled.tools).not.toContainEqual(expect.objectContaining({ name: "profile" }));
  });

  it("rejects stale programmatic revisions before loading a namespace", async () => {
    const configLoader = vi.fn(async () => ({
      default: defineAgent({ model: "openai/gpt-5.4" }),
    }));
    const loader = vi.fn(async () => ({
      default: defineTool({
        description: "Runtime entry.",
        execute: () => null,
        inputSchema: { type: "object" },
      }),
    }));
    const source = defineProgrammaticAgentSource({
      id: "revision-test",
      modules: [
        { loadNamespace: configLoader, logicalPath: "agent.ts" },
        { loadNamespace: loader, logicalPath: "tools/runtime.ts" },
      ],
      revision: "v1",
    });
    const sourceRegistry = createAgentSourceRegistry([{ applyTo: "root", source }]);
    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });
    const binding = Object.values(compiled.bindings).find(
      (candidate) => candidate.logicalPath === "tools/runtime.ts",
    )!;
    const staleRegistry = createAgentSourceRegistry([
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "revision-test",
          modules: [
            { loadNamespace: configLoader, logicalPath: "agent.ts" },
            { loadNamespace: loader, logicalPath: "tools/runtime.ts" },
          ],
          revision: "v2",
        }),
      },
    ]);

    await expect(
      createProgrammaticCompiledModuleMap(compiled, [frameworkAgentSourceRegistry, staleRegistry]),
    ).rejects.toThrow("revision mismatch");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(binding.backing.kind).toBe("programmatic");
  });
});
