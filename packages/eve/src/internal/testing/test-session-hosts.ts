import type { Runtime } from "#channel/types.js";
import type { StepFaults } from "#execution/in-process/step-attempts.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { sessionLineStore } from "#execution/hosts.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { WorkflowBody } from "#tools/workflow-body.js";

/** Where an in-process session's sign-in callbacks point unless a test names its own. */
const TEST_CALLBACK_BASE_URL = "http://test-session.in-process";

// Session tests written against Workflow's `workflowEntry`, on either host. A test starts a
// session from the initial entry, reads its stream, and delivers to its hooks with
// `resumeRoutedHook`, which reaches a session wherever it runs. Tests that check what Workflow
// itself does (its runs, its replay) keep running on Workflow.

/** Which host a session test runs its sessions on. */
export type TestSessionHostKind = "workflow" | "in-process";

/** A started session, as Workflow's run handle names it. */
export interface TestSessionRun {
  /** The session's id: on Workflow, its run's. */
  readonly runId: string;
  /** The session's stream, as its bytes. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Stops the session for good: Workflow cancels its run; in process, its host stops. */
  cancel(): Promise<void>;
  /** The runtime the session runs on, to send it messages and commands. */
  readonly runtime: Runtime;
}

/**
 * Starts a session of the agent the test runtime compiled from `entry` on `host`. Call it inside
 * the test runtime's `run`.
 */
export async function startTestSession(
  host: TestSessionHostKind,
  entry: InitialWorkflowEntryInput,
  options: {
    /** Where an in-process session's sign-in callbacks point; Workflow's come from its run. */
    readonly callbackBaseUrl?: string;
    /**
     * The plain bodies of the test agent's `"use workflow"` tools, which the in-process host
     * runs; Workflow runs their twins, which the test tier's bundler registers.
     */
    readonly workflows?: readonly WorkflowBody[];
    /** Turn steps that lose their completion, or fail, and run again; the in-process host's only. */
    readonly stepFaults?: StepFaults;
  } = {},
): Promise<TestSessionRun> {
  if (host === "workflow") {
    if (options.stepFaults !== undefined)
      throw new Error("Step faults are the in-process host's; Workflow's steps fail on their own.");
    const run = await startSessionOwner(workflowEntry, [entry]);
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    return { runId: run.runId, readable: run.readable, cancel: () => run.cancel(), runtime };
  }
  const runtime = createTestInProcessRuntime(
    { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
    {
      callbackBaseUrl: options.callbackBaseUrl ?? TEST_CALLBACK_BASE_URL,
      ...(options.stepFaults !== undefined && { stepFaults: options.stepFaults }),
    },
  );
  for (const { body, workflowId } of options.workflows ?? [])
    runtime.registerWorkflow(workflowId, body);
  const { ownerDeploymentId: _, ...initial } = entry;
  const { sessionId } = await runtime.startEntry(initial);
  return {
    runId: sessionId,
    readable: sessionLineStore(sessionId).readable(sessionId),
    cancel: () => runtime.dispose(),
    runtime,
  };
}
