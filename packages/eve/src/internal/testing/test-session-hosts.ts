import type { Runtime } from "#channel/types.js";
import type { StepFaults } from "#execution/in-process/step-attempts.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { sessionEventStore } from "#execution/hosts.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { WorkflowBody } from "#tools/workflow-body.js";

const TEST_CALLBACK_BASE_URL = "http://test-session.in-process";

export type TestSessionHostKind = "workflow" | "in-process";

export interface TestSessionRun {
  readonly runId: string;
  readonly readable: ReadableStream<Uint8Array>;
  cancel(): Promise<void>;
  readonly runtime: Runtime;
}

export async function startTestSession(
  host: TestSessionHostKind,
  entry: InitialWorkflowEntryInput,
  options: {
    readonly callbackBaseUrl?: string;
    readonly workflows?: readonly WorkflowBody[];
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
    readable: sessionEventStore(sessionId).readable(sessionId),
    cancel: () => runtime.dispose(),
    runtime,
  };
}
