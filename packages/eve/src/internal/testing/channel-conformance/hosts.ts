import type { Runtime } from "#channel/types.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { currentTestWorld } from "#internal/testing/workflow-test-world.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { questionWorkflowBodies } from "./question-workflows.js";

export type ConformanceHostKind = "workflow" | "in-process";

export interface ConformanceHost {
  readonly kind: ConformanceHostKind;
  readonly runtime: Runtime;
  addressClaimed(continuationToken: string): Promise<boolean>;
  runningSteps(sessionId: string): Promise<string[]>;
  settled(): Promise<void>;
  cancelRunOutsideEve(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

const TERMINAL_STEP_STATUSES = new Set(["completed", "failed", "cancelled"]);

const IN_PROCESS_CALLBACK_BASE_URL = "http://conformance.in-process";

export function conformanceHost(
  kind: ConformanceHostKind,
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): ConformanceHost {
  return kind === "workflow"
    ? workflowHost(compiledArtifactsSource)
    : inProcessHost(compiledArtifactsSource);
}

function workflowHost(compiledArtifactsSource: RuntimeCompiledArtifactsSource): ConformanceHost {
  return {
    kind: "workflow",
    runtime: createWorkflowRuntime({ compiledArtifactsSource }),
    async addressClaimed(continuationToken) {
      const world = await getWorld();
      return await world.hooks.getByToken(sessionInboxHookToken(continuationToken)).then(
        () => true,
        () => false,
      );
    },
    async runningSteps(sessionId) {
      const world = await getWorld();
      const steps = await world.steps.list({ resolveData: "none", runId: sessionId });
      return steps.data
        .filter((step) => !TERMINAL_STEP_STATUSES.has(step.status))
        .map((step) => `${step.stepName} (${step.status})`);
    },
    settled: () => currentTestWorld().idle(),
    async cancelRunOutsideEve(sessionId) {
      await getRun(sessionId).cancel();
    },
    dispose: async () => {},
  };
}

function inProcessHost(compiledArtifactsSource: RuntimeCompiledArtifactsSource): ConformanceHost {
  const runtime = createTestInProcessRuntime(
    { compiledArtifactsSource },
    {
      callbackBaseUrl: IN_PROCESS_CALLBACK_BASE_URL,
      deliveries: "immediate",
    },
  );
  for (const { body, workflowId } of questionWorkflowBodies())
    runtime.registerWorkflow(workflowId, body);
  return {
    kind: "in-process",
    runtime,
    addressClaimed: async (continuationToken) => runtime.holds(continuationToken),
    runningSteps: async (sessionId) =>
      runtime.stepsRunning(sessionId) > 0 ? ["turn step (running)"] : [],
    settled: () => runtime.idle(),
    cancelRunOutsideEve: async () => {
      throw new Error("An in-process session has no run to cancel outside eve.");
    },
    dispose: () => runtime.dispose(),
  };
}
