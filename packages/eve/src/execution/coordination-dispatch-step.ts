/** Starts workflow-tool runs for pending coordination. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
  type PreparedCoordinationDispatch,
} from "#execution/coordination-dispatch-shared.js";
import { isStubbableTool, runWorkflowToolStub } from "#execution/tool-stubs.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { findRegisteredRuntimeTool } from "#runtime/tools/registry.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { publishSessionEvents } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { startWorkflowTask, type StartWorkflowTaskInput } from "#execution/tools/workflow/start.js";
import { sendToTask, startTaskRun } from "#execution/tasks/start.js";
import {
  captureAgentSessionContext,
  resolveStepAgentLimits,
} from "#execution/agent-sessions/context.js";
import type { TaskStartedStreamEvent } from "#protocol/message.js";
import type { RuntimeActionResult, RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { HarnessSessionBase } from "#harness/types.js";

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park";
};

export async function dispatchCoordinationStep(
  input: CoordinationDispatchStepInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await withSessionStateDelta(input, dispatchCoordination);
}

async function dispatchCoordination(
  input: CoordinationDispatchStepInput,
): Promise<CoordinationDispatchResult> {
  const prepared = await prepareCoordinationDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  if (prepared === undefined) {
    return {
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const started: TaskStartedStreamEvent[] = [];
  const agentLimits = resolveStepAgentLimits(prepared);

  for (const task of prepared.plan) {
    const stubbed = await settleStubbedWorkflowCall(prepared, task);
    if (stubbed !== undefined) {
      results.push(stubbed);
      continue;
    }
    const start = {
      agentContext: captureAgentSessionContext(prepared, task.callId, agentLimits),
      auth: { current: prepared.auth, initiator: prepared.initiatorAuth },
      batchEvent: batch.event,
      owner: input.workflowToolRunOwner,
      parentSession: prepared.parentSession,
      session: nextSession,
      task,
    };
    const dispatched = await dispatchWorkflowCall(start);
    nextSession = dispatched.session;
    if (dispatched.result !== undefined) results.push(dispatched.result);
    if (dispatched.started !== undefined) started.push(dispatched.started);
  }

  const published = await publishSessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState:
        nextSession === session
          ? prepared.sessionState
          : createDurableSessionState({ session: nextSession }),
      sessionWritable: input.sessionWritable,
    },
    started,
  );
  return { results, ...published };
}

/**
 * In a session with a tool stub set, an authored workflow tool's call settles
 * with its stub's result and starts no run. Agent tools are not registered
 * tools; their sessions apply the set themselves.
 */
async function settleStubbedWorkflowCall(
  prepared: PreparedCoordinationDispatch,
  task: RuntimeWorkflowTaskRequest,
): Promise<RuntimeActionResult | undefined> {
  const set = prepared.toolStubSet;
  if (set === undefined) return undefined;
  const registered = findRegisteredRuntimeTool(prepared.bundle.toolRegistry, task.toolName);
  if (registered === null || !isStubbableTool(registered.definition)) return undefined;
  const sessionId = prepared.session.sessionId;
  const run = await runWorkflowToolStub({
    callId: task.callId,
    entryPoint: task.entry.entryPoint,
    input: task.input,
    session: { id: sessionId, rootId: prepared.parentSession?.rootSessionId ?? sessionId },
    set,
    toolName: task.toolName,
  });
  return createRuntimeToolResultFromValue({
    callId: task.callId,
    isError: run.kind === "error",
    output: run.kind === "output" ? run.output : run.message,
    toolName: task.toolName,
  });
}

/**
 * Starts the run the call's entry point names, or sends a call with `taskId`
 * to the running `serve` task it names.
 */
async function dispatchWorkflowCall(start: StartWorkflowTaskInput): Promise<{
  readonly result?: RuntimeActionResult;
  readonly session: HarnessSessionBase;
  readonly started?: TaskStartedStreamEvent;
}> {
  const { entry } = start.task;
  switch (entry.entryPoint) {
    case "execute":
      return await startWorkflowTask(start);
    case "task":
    case "serve":
      return await startTaskRun({ ...start, entry });
    case "receive":
      return await sendToTask({ ...start, taskId: entry.taskId });
  }
}
