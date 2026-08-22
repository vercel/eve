import { describe, expect, it } from "vitest";

import { prepareKernelCapabilities } from "#compiler/prepare-kernel-capabilities.js";

const base = {
  disabled: new Set<never>(),
  frameworkLoadSkill: false,
  hasSkills: false,
  isRoot: true,
  tasksEnabled: false,
  toolNames: new Set<string>(),
  webSearch: false,
  workflow: false,
} as const;

describe("prepareKernelCapabilities", () => {
  it("prepares only unconditional native work for a plain root", () => {
    expect(prepareKernelCapabilities(base)).toEqual(["agent", "ask_question"]);
  });

  it("prepares configured capabilities in stable inventory order", () => {
    expect(
      prepareKernelCapabilities({
        ...base,
        frameworkLoadSkill: true,
        hasSkills: true,
        tasksEnabled: true,
        webSearch: true,
        workflow: true,
      }),
    ).toEqual([
      "agent",
      "task_cancel",
      "task_update",
      "ask_question",
      "load_skill",
      "web_search",
      "Workflow",
    ]);
  });

  it("lets compiled tools replace native capabilities", () => {
    expect(
      prepareKernelCapabilities({
        ...base,
        tasksEnabled: true,
        toolNames: new Set(["agent", "task_cancel", "ask_question"]),
      }),
    ).toEqual(["task_update"]);
  });

  it("omits disabled native capabilities without retaining runtime disable state", () => {
    expect(
      prepareKernelCapabilities({
        ...base,
        disabled: new Set(["agent", "ask_question"]),
      }),
    ).toEqual([]);
  });

  it("does not prepare root-only capabilities for subagent nodes", () => {
    expect(
      prepareKernelCapabilities({
        ...base,
        isRoot: false,
        tasksEnabled: true,
      }),
    ).toEqual(["ask_question"]);
  });
});
