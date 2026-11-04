import type { Runtime } from "#channel/types.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

// The hosts a conversation's sessions run on, and what the harness asks each about them: whether
// an address is claimed, which steps still run, and how long a stream must stay unchanged before a
// person answers. Workflow is read through its World; the in-process host answers from its loop.

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
   * How long a resting stream must stay unchanged to count as resting. Workflow commits a step's
   * writes after it reports them; the in-process host reports a step once it's done.
   */
  readonly quietMs: number;
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
    quietMs: 250,
    async cancelRunOutsideEve(sessionId) {
      await getRun(sessionId).cancel();
    },
    // The test file's World outlives the conversation.
    dispose: async () => {},
  };
}

function inProcessHost(compiledArtifactsSource: RuntimeCompiledArtifactsSource): ConformanceHost {
  const runtime = createInProcessRuntime(
    { compiledArtifactsSource },
    { callbackBaseUrl: IN_PROCESS_CALLBACK_BASE_URL },
  );
  return {
    kind: "in-process",
    runtime,
    // Its inboxes hold an address by its continuation token itself.
    addressClaimed: async (continuationToken) => runtime.holds(continuationToken),
    runningSteps: async (sessionId) =>
      runtime.stepsRunning(sessionId) > 0 ? ["turn step (running)"] : [],
    quietMs: 0,
    cancelRunOutsideEve: async () => {
      throw new Error("An in-process session has no run to cancel outside eve.");
    },
    dispose: () => runtime.dispose(),
  };
}
