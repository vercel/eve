import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createKernelCapabilityPlan,
  getAdvertisedKernelPromptFeatures,
  getKernelCapabilityAtPath,
  getKernelCapabilityCanonicalPath,
  getKernelCompiledRequirements,
  getPreparedKernelTaskTargetReservations,
  getReplaceableKernelCapabilityAtPath,
  getReplaceableKernelCapabilityAtRuntimeToolName,
  getReservedKernelCapabilityNames,
  isKernelCapabilityAdvertised,
  KERNEL_CAPABILITY_NAMES,
  prepareKernelCapabilityPlan,
  projectPreparedKernelCapabilitiesForInspection,
  resolveRejectedKernelProviderCapabilities,
  resolveSessionKernelPlan,
  type KernelCapabilityAdvertisementInput,
  type KernelCapabilityName,
  type KernelCapabilityPreparationInput,
} from "#kernel/capabilities.js";
import {
  classifyKernelRuntimeCall,
  dispatchKernelTaskControl,
  installKernelProviderTool,
  installPreparedKernelTurnTool,
  materializePreparedKernelNodeTools,
  usePreparedKernelWorkflow,
} from "#kernel/executable-capabilities.js";

const fullPreparation: KernelCapabilityPreparationInput = {
  disabled: new Set(),
  frameworkLoadSkill: true,
  hasSkills: true,
  isRoot: true,
  replaced: new Set(),
  tasksEnabled: true,
  webSearch: true,
  workflow: true,
};

const expectedLifecycle = {
  agent: { path: "tools/agent.ts", replaceable: true, requirements: [] },
  task_cancel: {
    path: "tools/task_cancel.ts",
    replaceable: true,
    requirements: [],
  },
  task_update: {
    path: "tools/task_update.ts",
    replaceable: true,
    requirements: [],
  },
  ask_question: {
    path: "tools/ask_question.ts",
    replaceable: true,
    requirements: [],
  },
  load_skill: {
    path: "tools/load_skill.ts",
    replaceable: true,
    requirements: ["canonical-framework-tool", "skills"],
  },
  web_search: {
    path: "tools/web_search.ts",
    replaceable: true,
    requirements: ["web-search-provider"],
  },
  Workflow: {
    path: "tools/workflow.ts",
    replaceable: true,
    requirements: ["workflow-config"],
  },
  final_output: { path: "tools/final_output.ts", replaceable: false, requirements: [] },
} as const satisfies Record<KernelCapabilityName, unknown>;

function advertised(
  input: KernelCapabilityAdvertisementInput,
  plan = prepareKernelCapabilityPlan(fullPreparation),
): readonly KernelCapabilityName[] {
  return KERNEL_CAPABILITY_NAMES.filter((name) => isKernelCapabilityAdvertised(plan, name, input));
}

describe("kernel capability lifecycle", () => {
  it("projects one canonical lifecycle identity for every literal capability name", () => {
    expect(KERNEL_CAPABILITY_NAMES).toEqual(Object.keys(expectedLifecycle));
    for (const name of KERNEL_CAPABILITY_NAMES) {
      const expected = expectedLifecycle[name];
      expect(getKernelCapabilityCanonicalPath(name)).toBe(expected.path);
      expect(getKernelCapabilityAtPath(expected.path)).toBe(name);
      expect(getKernelCompiledRequirements(name)).toEqual(expected.requirements);
      expect(getReplaceableKernelCapabilityAtRuntimeToolName(name)).toBe(
        expected.replaceable ? name : undefined,
      );
    }
    expect(getReservedKernelCapabilityNames()).toEqual(["final_output"]);
  });

  it("runs every executable stage through the inventory", async () => {
    const plan = prepareKernelCapabilityPlan(fullPreparation);
    const materialized = materializePreparedKernelNodeTools(plan, {
      agent: (name) => name,
      askQuestion: (name) => name,
      taskCancel: (name) => name,
      taskUpdate: (name) => name,
      webSearch: (name) => name,
    });
    expect(materialized).toEqual([
      "agent",
      "task_cancel",
      "task_update",
      "ask_question",
      "web_search",
    ]);

    const installWebSearch = vi.fn(async () => "provider-tool");
    await expect(
      installKernelProviderTool("web_search", {
        installWebSearch,
        modelSupportsProviderTools: true,
      }),
    ).resolves.toEqual({ handled: true, tool: "provider-tool" });
    expect(installWebSearch).toHaveBeenCalledOnce();

    const workflow = vi.fn(() => "workflow");
    expect(usePreparedKernelWorkflow(plan, workflow)).toBe("workflow");
    expect(workflow).toHaveBeenCalledOnce();
    expect(
      installPreparedKernelTurnTool(plan, {
        installFinalOutput: (name) => `${name}:installed`,
        structuredOutput: true,
      }),
    ).toBe("final_output:installed");

    await expect(
      dispatchKernelTaskControl("task_update", {
        cancel: async () => "cancel",
        update: async () => "update",
      }),
    ).resolves.toBe("update");

    const loadSkill = classifyKernelRuntimeCall("load_skill", {
      definition: {
        description: "Load",
        inputSchema: z.object({}),
        kernelCapability: "load_skill",
        name: "load_skill",
      },
      resolveInput: () => ({ name: "docs" }),
      toolCall: { input: {}, toolCallId: "call", toolName: "load_skill" },
    });
    expect(loadSkill).toEqual({ callId: "call", input: { name: "docs" }, kind: "load-skill" });
  });

  it("prepares every capability in stable inventory order", () => {
    expect(prepareKernelCapabilityPlan(fullPreparation).prepared).toEqual(KERNEL_CAPABILITY_NAMES);
  });

  it("recovers upstream provider types only for capabilities installed on the failed call", () => {
    expect(
      resolveRejectedKernelProviderCapabilities(new Set(["web_search"]), [
        "computer_20251022",
        "web_search_20250305",
      ]),
    ).toEqual(["web_search"]);
    expect(resolveRejectedKernelProviderCapabilities(new Set(), ["web_search_20250305"])).toEqual(
      [],
    );
    expect(
      resolveRejectedKernelProviderCapabilities(new Set(["web_search"]), ["some.future.tool"]),
    ).toEqual([]);
  });

  it("applies replacement and disablement before every downstream stage", () => {
    for (const name of KERNEL_CAPABILITY_NAMES) {
      const replacement = getReplaceableKernelCapabilityAtRuntimeToolName(name);
      const plan = prepareKernelCapabilityPlan({
        ...fullPreparation,
        disabled: new Set([name]),
        replaced: replacement === undefined ? new Set() : new Set([replacement]),
      });
      expect(plan.prepared, `${name} should not remain prepared`).not.toContain(name);
      expect(
        isKernelCapabilityAdvertised(plan, name, {
          delegatedCaller: true,
          modelSupportsProviderTools: true,
          requestInput: true,
          rootSession: true,
          structuredOutput: true,
          subagentDepth: 0,
        }),
      ).toBe(false);
    }
  });

  it("advertises exact root, named-task-child, and non-task-child sets", () => {
    expect(
      advertised({
        modelSupportsProviderTools: true,
        requestInput: true,
        rootSession: true,
        structuredOutput: true,
        subagentDepth: 0,
      }),
    ).toEqual([
      "agent",
      "task_cancel",
      "ask_question",
      "load_skill",
      "web_search",
      "Workflow",
      "final_output",
    ]);

    const child = {
      modelSupportsProviderTools: true,
      requestInput: true,
      rootSession: false,
      structuredOutput: false,
      subagentDepth: 1,
    } as const;
    expect(advertised({ ...child, delegatedCaller: true })).toEqual([
      "task_update",
      "ask_question",
      "load_skill",
      "web_search",
    ]);
    expect(advertised({ ...child, delegatedCaller: false })).toEqual([
      "ask_question",
      "load_skill",
      "web_search",
    ]);
  });

  it("uses the same model availability for prompt and advertisement", () => {
    const plan = createKernelCapabilityPlan(["web_search"]);
    const unavailable = {
      modelSupportsProviderTools: false,
      rootSession: true,
      subagentDepth: 0,
    } as const;
    expect(isKernelCapabilityAdvertised(plan, "web_search", unavailable)).toBe(false);
    expect([...getAdvertisedKernelPromptFeatures(plan, unavailable)]).toEqual([]);
    expect([
      ...getAdvertisedKernelPromptFeatures(
        plan,
        { ...unavailable, modelSupportsProviderTools: true },
        { excludedScopes: new Set(["model"]) },
      ),
    ]).toEqual([]);
  });

  it("derives task-child authority without mutating or duplicating the node plan", () => {
    const nodePlan = createKernelCapabilityPlan(["ask_question", "final_output"]);
    const resolution = resolveSessionKernelPlan({
      nodePlan,
      rootPlan: createKernelCapabilityPlan(["task_update"]),
      taskOwned: true,
    });
    expect(nodePlan.prepared).toEqual(["ask_question", "final_output"]);
    expect(resolution.plan.prepared).toEqual(["task_update", "ask_question", "final_output"]);
    expect(resolution.taskControl).toEqual({ taskUpdate: true });

    const rootResolution = resolveSessionKernelPlan({
      nodePlan: createKernelCapabilityPlan(["task_update", "ask_question"]),
      rootPlan: createKernelCapabilityPlan(["task_update"]),
      taskOwned: true,
    });
    expect(rootResolution.plan.prepared).toEqual(["task_update", "ask_question"]);
  });

  it("plans and advertises the exact task-owned self-delegated root lifecycle", () => {
    const rootPlan = prepareKernelCapabilityPlan(fullPreparation);
    const resolution = resolveSessionKernelPlan({
      nodePlan: rootPlan,
      rootPlan,
      taskOwned: true,
    });

    expect(resolution).toEqual({
      plan: rootPlan,
      taskControl: { taskUpdate: true },
    });
    expect(
      advertised(
        {
          delegatedCaller: resolution.taskControl.taskUpdate,
          modelSupportsProviderTools: true,
          requestInput: true,
          rootSession: false,
          structuredOutput: false,
          subagentDepth: 1,
        },
        resolution.plan,
      ),
    ).toEqual(["task_update", "ask_question", "load_skill", "web_search"]);
    expect([
      ...getAdvertisedKernelPromptFeatures(resolution.plan, {
        delegatedCaller: resolution.taskControl.taskUpdate,
        modelSupportsProviderTools: true,
        requestInput: true,
        rootSession: false,
        structuredOutput: false,
        subagentDepth: 1,
      }),
    ]).toEqual(["task-update-guidance", "tools-available"]);
  });

  it("derives task-target reservations from the prepared root plan", () => {
    expect([
      ...getPreparedKernelTaskTargetReservations(prepareKernelCapabilityPlan(fullPreparation)),
    ]).toEqual(["task_update"]);
    expect([
      ...getPreparedKernelTaskTargetReservations(
        prepareKernelCapabilityPlan({ ...fullPreparation, tasksEnabled: false }),
      ),
    ]).toEqual([]);
  });

  it("projects native and ordinary framework inspection from the prepared plan", () => {
    const projection = projectPreparedKernelCapabilitiesForInspection(
      createKernelCapabilityPlan(["load_skill", "web_search"]),
    );
    expect([...projection.frameworkSourcePaths]).toEqual(["tools/load_skill.ts"]);
    expect(projection.native).toEqual([
      {
        canonicalPath: "tools/web_search.ts",
        description: "",
        hasAuth: false,
        hasExecute: false,
        hasModelOutputProjection: false,
        hasOutputSchema: false,
        inputSchema: null,
        kind: "native",
        name: "web_search",
        outputSchema: null,
        requiresApproval: false,
        sourceKind: "kernel",
      },
    ]);
  });
});

describe("kernel capability paths", () => {
  it("uses canonical module identity across authored extensions", () => {
    expect(getKernelCapabilityAtPath("tools/agent.mjs")).toBe("agent");
    expect(getReplaceableKernelCapabilityAtPath("tools/web_search.cts")).toBe("web_search");
  });

  it("keeps reserved capabilities non-replaceable", () => {
    expect(getKernelCapabilityAtPath("tools/final_output.js")).toBe("final_output");
    expect(getReplaceableKernelCapabilityAtPath("tools/final_output.js")).toBeUndefined();
  });
});
