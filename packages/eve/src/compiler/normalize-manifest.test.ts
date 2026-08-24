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
import { defineChannel, GET } from "#public/definitions/channel.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineTool, disableTool } from "#public/definitions/tool.js";

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
          default: defineAgent({ model: "openai/gpt-5.4" }),
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

  it("rejects stale programmatic revisions before loading a namespace", async () => {
    const loader = vi.fn(async () => ({ default: defineAgent({ model: "openai/gpt-5.4" }) }));
    const source = defineProgrammaticAgentSource({
      id: "revision-test",
      modules: [{ loadNamespace: loader, logicalPath: "agent.ts" }],
      revision: "v1",
    });
    const sourceRegistry = createAgentSourceRegistry([{ applyTo: "root", source }]);
    const compiled = await compileAgentManifest(manifest(), {
      sourceRegistries: [sourceRegistry],
    });
    const binding = compiled.bindings[compiled.config.source.sourceId]!;
    const staleRegistry = createAgentSourceRegistry([
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "revision-test",
          modules: [{ loadNamespace: loader, logicalPath: "agent.ts" }],
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
