import { describe, expect, it } from "vitest";

import { AssertionCollector } from "#evals/assertions/collector.js";
import { createScopedAssertions } from "#evals/assertions/scoped.js";
import type { TargetTools } from "#evals/target.js";

function assertionsFor(tools: TargetTools | undefined) {
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

  it("accept a retired name the root agent authors, that a dynamic tool resolver may return, or when its tools are unknown", () => {
    expect(() =>
      assertionsFor({ dynamic: false, static: ["task_wait"] }).notCalledTool("task_wait"),
    ).not.toThrow();
    expect(() =>
      assertionsFor({ dynamic: true, static: [] }).calledTool("load_skill"),
    ).not.toThrow();
    expect(() => assertionsFor(undefined).toolOrder(["final_output"])).not.toThrow();
  });

  it.each([
    [
      "eve__tool",
      "Calls through eve__tool are reported under the entry's name; assert on the tool or agent it reaches.",
    ],
    [
      "eve__skill",
      "Calls through eve__skill are reported as skill loads; use t.loadedSkill(name).",
    ],
    [
      "eve__execute",
      "eve__execute isn't a tool eve registers (it's reserved for code mode); assert on the tool or agent a call reaches, or use t.loadedSkill(name).",
    ],
  ])("always reject %s, which no call is reported under", (name, message) => {
    expect(() => assertionsFor(undefined).notCalledTool(name)).toThrow(message);
    expect(() => assertionsFor({ dynamic: true, static: [name] }).calledTool(name)).toThrow(
      message,
    );
  });
});
