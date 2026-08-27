import { describe, expect, it, vi } from "vitest";

import { NodeModuleEvaluationContext } from "#compiler/module-lifecycle.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  type AgentModuleBinding,
} from "#compiler/source-graph.js";

const owner = { kind: "application" as const };

function programmaticBinding(
  moduleId: string,
  dependencies?: Readonly<Record<string, string>>,
): AgentModuleBinding {
  return {
    backing: {
      dependencies,
      kind: "programmatic",
      moduleId,
      registryId: "lifecycle-test",
      revision: "v1",
    },
    logicalPath: moduleId,
    owner,
  };
}

describe("node module lifecycle", () => {
  it("loads each namespace once across config and resource compilation", async () => {
    const loadConfig = vi.fn(async () => ({ default: { model: "openai/gpt-5.4" } }));
    const loadTool = vi.fn(async () => ({ default: { execute: () => null } }));
    const source = defineProgrammaticAgentSource({
      id: "lifecycle-test",
      modules: [
        { loadNamespace: loadConfig, logicalPath: "agent.ts" },
        { loadNamespace: loadTool, logicalPath: "tools/runtime.ts" },
      ],
      revision: "v1",
    });
    const context = new NodeModuleEvaluationContext([
      createAgentSourceRegistry([{ applyTo: "root", source }]),
    ]);
    const config = programmaticBinding("agent.ts");
    const tool = programmaticBinding("tools/runtime.ts");

    context.setBindings({ config });
    const firstConfig = await context.loadNamespace("config");
    context.setBindings({ config, tool });
    const secondConfig = await context.loadNamespace("config");
    await context.loadNamespace("tool");
    context.requireRuntimeEntry("tool");

    expect(firstConfig).toBe(secondConfig);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(loadTool).toHaveBeenCalledTimes(1);
    expect(context.finalizeBindings()).toMatchObject({
      config: { usage: { compile: true, runtimeEntry: false } },
      tool: { usage: { compile: true, runtimeEntry: true } },
    });
  });

  it("links transitive programmatic dependencies into runtime entries", () => {
    const context = new NodeModuleEvaluationContext([]);
    context.setBindings({
      dependency: programmaticBinding("dependency.ts"),
      root: programmaticBinding("root.ts", { dependency: "dependency" }),
    });
    context.requireRuntimeEntry("root");

    expect(context.finalizeBindings()).toMatchObject({
      dependency: { usage: { compile: false, runtimeEntry: true } },
      root: { usage: { compile: false, runtimeEntry: true } },
    });
  });

  it("rejects missing dependencies, cycles, and unused selected bindings", () => {
    const missing = new NodeModuleEvaluationContext([]);
    missing.setBindings({ root: programmaticBinding("root.ts", { dependency: "missing" }) });
    missing.requireRuntimeEntry("root");
    expect(() => missing.finalizeBindings()).toThrow(
      'Runtime module entry "missing" has no selected binding.',
    );

    const cyclic = new NodeModuleEvaluationContext([]);
    cyclic.setBindings({
      left: programmaticBinding("left.ts", { right: "right" }),
      right: programmaticBinding("right.ts", { left: "left" }),
    });
    cyclic.requireRuntimeEntry("left");
    expect(() => cyclic.finalizeBindings()).toThrow(
      'Compiled module dependency cycle includes "left".',
    );

    const unused = new NodeModuleEvaluationContext([]);
    unused.setBindings({ unused: programmaticBinding("unused.ts") });
    expect(() => unused.finalizeBindings()).toThrow(
      'Selected module binding "unused" has no compile or runtime usage.',
    );
  });
});
