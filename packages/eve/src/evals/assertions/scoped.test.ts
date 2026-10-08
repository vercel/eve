import { describe, expect, it } from "vitest";

import { AssertionCollector } from "#evals/assertions/collector.js";
import { createScopedAssertions } from "#evals/assertions/scoped.js";
import type { EveEvalTargetCapabilities } from "#evals/types.js";

function assertionsFor(tools: EveEvalTargetCapabilities["tools"]) {
  return createScopedAssertions(new AssertionCollector(tools), {
    timing: "final",
    select: (result) => result,
  });
}

describe("tool-name assertions", () => {
  it.each([
    ["load_skill", 'Tool name "load_skill" was retired; use t.loadedSkill(name).'],
    ["task_wait", 'Tool name "task_wait" was retired; use eve__task_wait.'],
    ["task_cancel", 'Tool name "task_cancel" was retired; use eve__task_cancel.'],
    ["final_output", 'Tool name "final_output" was retired; use eve__reply.'],
    ["connection_search", 'Tool name "connection_search" was retired; use eve__search.'],
    [
      "connection_execute",
      'Tool name "connection_execute" was retired; assert on the connection tool\'s own name, `<connection>__<tool>`.',
    ],
  ])("reject %s when the root agent has no tool by that name", (name, message) => {
    const t = assertionsFor({ dynamic: false, static: ["lookup"] });

    expect(() => t.calledTool(name)).toThrow(message);
    expect(() => t.notCalledTool(name)).toThrow(message);
    expect(() => t.toolOrder(["lookup", name])).toThrow(message);
    expect(() => t.notCalledTool("lookup")).not.toThrow();
  });

  it("accept a retired name the root agent authors, or that a dynamic tool resolver may return", () => {
    expect(() =>
      assertionsFor({ dynamic: false, static: ["task_wait"] }).notCalledTool("task_wait"),
    ).not.toThrow();
    expect(() =>
      assertionsFor({ dynamic: true, static: [] }).calledTool("load_skill"),
    ).not.toThrow();
  });

  it("always reject eve__execute, whose calls are reported under the entry they reach", () => {
    const message =
      "Calls through eve__execute are reported under the entry's name; assert on the tool or agent it reaches, or use t.loadedSkill for skills.";

    expect(() => assertionsFor(undefined).notCalledTool("eve__execute")).toThrow(message);
    expect(() => assertionsFor({ dynamic: true, static: [] }).calledTool("eve__execute")).toThrow(
      message,
    );
  });
});
