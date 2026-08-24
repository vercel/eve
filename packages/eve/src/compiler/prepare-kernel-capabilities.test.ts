import { describe, expect, it } from "vitest";

import { prepareKernelCapabilityPlan } from "#kernel/capabilities.js";

const base = {
  disabled: new Set<never>(),
  frameworkLoadSkill: false,
  hasSkills: false,
  isRoot: true,
  replaced: new Set<never>(),
  tasksEnabled: false,
  webSearch: false,
  workflow: false,
} as const;

describe("prepareKernelCapabilityPlan", () => {
  it("prepares only unconditional native work for a plain root", () => {
    expect(prepareKernelCapabilityPlan(base).prepared).toEqual([
      "agent",
      "ask_question",
      "final_output",
    ]);
  });

  it("prepares configured capabilities in stable inventory order", () => {
    expect(
      prepareKernelCapabilityPlan({
        ...base,
        frameworkLoadSkill: true,
        hasSkills: true,
        tasksEnabled: true,
        webSearch: true,
        workflow: true,
      }).prepared,
    ).toEqual([
      "agent",
      "task_cancel",
      "task_update",
      "ask_question",
      "load_skill",
      "web_search",
      "Workflow",
      "final_output",
    ]);
  });

  it("lets compiled tools replace native capabilities", () => {
    expect(
      prepareKernelCapabilityPlan({
        ...base,
        tasksEnabled: true,
        replaced: new Set(["agent", "task_cancel", "ask_question"]),
      }).prepared,
    ).toEqual(["task_update", "final_output"]);
  });

  it("omits disabled native capabilities without retaining runtime disable state", () => {
    expect(
      prepareKernelCapabilityPlan({
        ...base,
        disabled: new Set(["agent", "ask_question"]),
      }).prepared,
    ).toEqual(["final_output"]);
  });

  it("keeps task capabilities in the root application plan", () => {
    expect(
      prepareKernelCapabilityPlan({
        ...base,
        isRoot: false,
        tasksEnabled: true,
      }).prepared,
    ).toEqual(["ask_question", "final_output"]);
  });
});
