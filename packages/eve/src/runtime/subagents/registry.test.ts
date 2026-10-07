import { describe, expect, it } from "vitest";

import { createRuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { ResolvedRuntimeSubagentNode } from "#runtime/types.js";

function subagent(tool?: boolean, name = "researcher"): ResolvedRuntimeSubagentNode {
  return {
    description: "Research difficult questions.",
    kind: "subagent",
    logicalPath: `subagents/${name}`,
    name,
    nodeId: `subagents/${name}`,
    sourceId: `subagents/${name}`,
    sourceKind: "module",
    tool,
  };
}

describe("createRuntimeSubagentRegistry", () => {
  it("registers a tool-disabled subagent without preparing a model tool", () => {
    const registry = createRuntimeSubagentRegistry({ subagents: [subagent(false)] });

    expect(registry.preparedTools).toEqual([]);
    expect(registry.subagentsByName.has("researcher")).toBe(true);
    expect(registry.subagentsByNodeId.has("subagents/researcher")).toBe(true);
  });

  it("applies a same-named disabled tool without removing the subagent", () => {
    const registry = createRuntimeSubagentRegistry({
      disabledToolNames: ["researcher"],
      subagents: [subagent()],
    });

    expect(registry.preparedTools).toEqual([]);
    expect(registry.subagentsByName.has("researcher")).toBe(true);
  });

  it("allows an authored wrapper to use a tool-disabled subagent name", () => {
    const registry = createRuntimeSubagentRegistry({
      reservedToolNames: ["researcher"],
      subagents: [subagent(false)],
    });

    expect(registry.preparedTools).toEqual([]);
    expect(registry.subagentsByName.has("researcher")).toBe(true);
  });

  it("rejects an authored tool that collides with a model-visible subagent", () => {
    expect(() =>
      createRuntimeSubagentRegistry({
        reservedToolNames: ["researcher"],
        subagents: [subagent()],
      }),
    ).toThrow('Subagent "researcher" collides with another runtime-visible tool name.');
  });

  it("rejects a model-visible subagent named after a runtime tool, but lets a tool: false one keep the name", () => {
    expect(() =>
      createRuntimeSubagentRegistry({ subagents: [subagent(true, "task_wait")] }),
    ).toThrow(
      'Subagent "subagents/task_wait" uses the reserved name "task_wait". Rename its path; eve reserves "task_wait" for its built-in task tool.',
    );

    const hidden = createRuntimeSubagentRegistry({ subagents: [subagent(false, "task_wait")] });
    expect(hidden.preparedTools).toEqual([]);
    expect(hidden.subagentsByName.has("task_wait")).toBe(true);
  });
});
