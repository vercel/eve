import { describe, expect, it } from "vitest";

import { createKernelCapabilityPlan } from "#kernel/capabilities.js";
import { materializeKernelNodeTools } from "#kernel/materialize.js";

describe("materializeKernelNodeTools", () => {
  it("materializes every node-native strategy with its lifecycle identity", () => {
    const tools = materializeKernelNodeTools({
      nodeId: "__root__",
      persistentSubagentSessions: false,
      plan: createKernelCapabilityPlan([
        "agent",
        "task_cancel",
        "task_update",
        "ask_question",
        "load_skill",
        "web_search",
        "Workflow",
        "final_output",
      ]),
      tasksEnabled: false,
    });

    expect([...tools.keys()]).toEqual([
      "agent",
      "task_cancel",
      "task_update",
      "ask_question",
      "web_search",
    ]);
    for (const [name, definition] of tools) {
      expect(definition.kernelCapability).toBe(name);
    }
    expect(tools.get("agent")?.runtimeAction?.kind).toBe("subagent-call");
    expect(tools.get("task_cancel")?.runtimeAction?.kind).toBe("task-control");
    expect(tools.get("task_update")?.runtimeAction?.kind).toBe("task-control");
    expect(tools.get("ask_question")?.execute).toBeUndefined();
    expect(tools.get("web_search")?.execute).toBeUndefined();
  });

  it("selects background self-delegation when task execution is enabled", () => {
    const tools = materializeKernelNodeTools({
      nodeId: "__root__",
      persistentSubagentSessions: false,
      plan: createKernelCapabilityPlan(["agent"]),
      tasksEnabled: true,
    });

    expect(tools.get("agent")).toMatchObject({
      execution: "background",
      kernelCapability: "agent",
    });
    expect(tools.get("agent")?.execute).toBeTypeOf("function");
  });

  it("leaves ordinary, Workflow, and turn materializers to their owning stages", () => {
    const tools = materializeKernelNodeTools({
      nodeId: "__root__",
      persistentSubagentSessions: false,
      plan: createKernelCapabilityPlan(["load_skill", "Workflow", "final_output"]),
      tasksEnabled: false,
    });

    expect(tools.size).toBe(0);
  });
});
