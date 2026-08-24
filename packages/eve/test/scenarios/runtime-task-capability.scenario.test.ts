import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import {
  getAdvertisedKernelPromptFeatures,
  resolveSessionKernelPlan,
} from "#kernel/capabilities.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const createAppRoot = useTemporaryAppRoots();

describe("runtime task capability preparation", () => {
  it("preserves root-authorized task_update across named and dynamic child runtime planning", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-runtime-task-capability-", {
      packageName: "runtime-task-capability-test-agent",
    });
    const childRoot = join(agentRoot, "subagents", "researcher");
    const dynamicChildRoot = join(agentRoot, "subagents", "conditional");

    await Promise.all([
      mkdir(childRoot, { recursive: true }),
      mkdir(dynamicChildRoot, { recursive: true }),
    ]);
    await writeFile(
      join(agentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: { tasks: true },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(agentRoot, "instructions.md"), "Coordinate the research task.\n");
    await writeFile(
      join(childRoot, "agent.ts"),
      [
        "export default {",
        '  description: "Research one topic.",',
        '  model: "openai/gpt-5.4",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(childRoot, "instructions.md"), "Research the assigned topic.\n");
    await writeFile(
      join(dynamicChildRoot, "agent.ts"),
      [
        "export default {",
        '  kind: "eve:dynamic",',
        "  events: {",
        '    "session.started": () => ({',
        '      description: "Conditionally available researcher.",',
        '      model: "openai/gpt-5.4",',
        "    }),",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dynamicChildRoot, "instructions.md"),
      "Research when conditionally selected.\n",
    );

    const compileResult = await compileAgent({ startPath: appRoot });

    const childBundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(appRoot),
      nodeId: "subagents/researcher",
    });

    expect(childBundle.graph.root.nodeId).toBe("__root__");
    expect(childBundle.graph.root.agent.kernelPlan.prepared).toContain("task_update");
    expect(childBundle.resolvedAgent.kernelPlan.prepared).not.toContain("task_update");
    const sessionKernel = resolveSessionKernelPlan({
      nodePlan: childBundle.resolvedAgent.kernelPlan,
      rootPlan: childBundle.graph.root.agent.kernelPlan,
      taskOwned: true,
    });
    expect(sessionKernel.taskControl).toEqual({ taskUpdate: true });
    expect(sessionKernel.plan.prepared).toContain("task_update");
    expect(
      getAdvertisedKernelPromptFeatures(sessionKernel.plan, {
        delegatedCaller: sessionKernel.taskControl.taskUpdate,
        rootSession: false,
        subagentDepth: 1,
      }).has("task-update-guidance"),
    ).toBe(true);

    const context = new ContextContainer();
    context.set(BundleKey, childBundle);
    const rehydratedBundle = (await deserializeContext(serializeContext(context))).require(
      BundleKey,
    );

    expect(rehydratedBundle.nodeId).toBe("subagents/researcher");
    expect(rehydratedBundle.graph.root.nodeId).toBe("__root__");
    const rehydratedSessionKernel = resolveSessionKernelPlan({
      nodePlan: rehydratedBundle.resolvedAgent.kernelPlan,
      rootPlan: rehydratedBundle.graph.root.agent.kernelPlan,
      taskOwned: true,
    });
    expect(rehydratedSessionKernel.taskControl).toEqual({ taskUpdate: true });
    expect(rehydratedSessionKernel.plan.prepared).toContain("task_update");

    const dynamicChild = compileResult.manifest.subagents.find(
      (candidate) => candidate.nodeId === "subagents/conditional",
    );
    expect(dynamicChild?.configResolver).toBeDefined();
    const dynamicChildBundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(appRoot),
      nodeId: "subagents/conditional",
    });
    const dynamicSessionKernel = resolveSessionKernelPlan({
      nodePlan: dynamicChildBundle.resolvedAgent.kernelPlan,
      rootPlan: dynamicChildBundle.graph.root.agent.kernelPlan,
      taskOwned: true,
    });

    expect(dynamicChildBundle.turnAgent.configResolver).toBe(true);
    expect(dynamicSessionKernel.taskControl).toEqual({ taskUpdate: true });
    expect(dynamicSessionKernel.plan.prepared).toContain("task_update");
  });
});
