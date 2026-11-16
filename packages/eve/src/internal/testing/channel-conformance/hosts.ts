import type { Runtime } from "#channel/types.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { currentTestWorld } from "#internal/testing/workflow-test-world.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { questionWorkflowBodies } from "./question-workflows.js";

// The hosts a conversation's sessions run on, and what the harness asks each about them: whether
// an address is claimed, which steps still run, and when nothing in the host is working. Workflow
// is read through its World and the test World's queue; the in-process host answers from its loop.

/** Which host a conversation's sessions run on. */
export type ConformanceHostKind = "workflow" | "in-process";

export interface ConformanceHost {
  readonly kind: ConformanceHostKind;
  readonly runtime: Runtime;
  /** Whether a session holds the address its continuation token names. */
  addressClaimed(continuationToken: string): Promise<boolean>;
  /** The names of `sessionId`'s steps that haven't finished. */
  runningSteps(sessionId: string): Promise<string[]>;
  /**
   * Resolves once nothing in the host is working: no step, delivery or session start in flight,
   * as the host battery reads it (`session-host/host-under-test.ts`).
   */
  settled(): Promise<void>;
  /** Cancels `sessionId`'s run outside eve, as an operator would. Workflow only. */
  cancelRunOutsideEve(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

const TERMINAL_STEP_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** Where an in-process session's sign-in callbacks point; the harness reads only their path. */
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
    // The test file's World outlives the conversation.
    dispose: async () => {},
  };
}

function inProcessHost(compiledArtifactsSource: RuntimeCompiledArtifactsSource): ConformanceHost {
  const runtime = createTestInProcessRuntime(
    { compiledArtifactsSource },
    {
      callbackBaseUrl: IN_PROCESS_CALLBACK_BASE_URL,
      // Batched, a budget prompt's answer typed back to back with another message is sometimes
      // read joined to it (vercel/eve#6307), so those cells fail at random rather than every
      // time, and can't be recorded as broken. Batch here once #6307 lands.
      deliveries: "immediate",
    },
  );
  // The test agent's workflow tools, as the plain bodies their `"use workflow"` twins wrap.
  for (const { body, workflowId } of questionWorkflowBodies())
    runtime.registerWorkflow(workflowId, body);
  return {
    kind: "in-process",
    runtime,
    // Its inboxes hold an address by its continuation token itself.
    addressClaimed: async (continuationToken) => runtime.holds(continuationToken),
    // Only turn steps cross the step boundary and are counted here; the short steps that settle a
    // control delivery or a cancelled turn, or prewarm a session, run inline.
    runningSteps: async (sessionId) =>
      runtime.stepsRunning(sessionId) > 0 ? ["turn step (running)"] : [],
    settled: () => runtime.idle(),
    cancelRunOutsideEve: async () => {
      throw new Error("An in-process session has no run to cancel outside eve.");
    },
    dispose: () => runtime.dispose(),
  };
}
