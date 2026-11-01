import { describe, expect, it, vi } from "vitest";

import { NodeModuleEvaluationContext } from "#compiler/module-lifecycle.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  type AgentModuleBinding,
} from "#compiler/source-graph.js";

const owner = { kind: "application" as const };

function programmaticBinding(moduleId: string): AgentModuleBinding {
  return {
    backing: {
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

  it("rejects a runtime entry without a binding, and unused selected bindings", () => {
    const missing = new NodeModuleEvaluationContext([]);
    missing.setBindings({});
    missing.requireRuntimeEntry("missing");
    expect(() => missing.finalizeBindings()).toThrow(
      'Runtime module entry "missing" has no selected binding.',
    );

    const unused = new NodeModuleEvaluationContext([]);
    unused.setBindings({ unused: programmaticBinding("unused.ts") });
    expect(() => unused.finalizeBindings()).toThrow(
      'Selected module binding "unused" has no compile or runtime usage.',
    );
  });
});
