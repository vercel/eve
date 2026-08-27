import {
  createAgentErrorResult,
  type DispatchOutcome,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import {
  findActiveTaskForAgent,
  findTaskAgentAddress,
} from "#execution/tasks/parent/control-shared.js";
import {
  failDelegatedDispatch,
  rejectDelegatedDispatch,
  settleDelegatedDispatch,
  type DelegatedTask,
} from "#execution/tasks/parent/delegate.js";
import { describeTaskAgent } from "#execution/tasks/parent/agent-identity.js";
import { AGENT_BUSY } from "#harness/agent-handle-errors.js";
import type { RuntimeSubagentDispatchFailure } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";

export type PersistedContinuationTask = Awaited<ReturnType<typeof settleDelegatedDispatch>>;

/** Describes task identity from the stored address when continuing an agent. */
export function describeTaskDispatch(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string | undefined;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): ReturnType<typeof describeTaskAgent> {
  const described = describeTaskAgent(input);
  const handle =
    input.agentId === undefined ? undefined : findTaskAgentAddress(input.session, input.agentId);
  return handle === undefined
    ? described
    : {
        ...described,
        mode: handle.address.kind === "agent/remote" ? "remote" : "local",
      };
}

export async function checkTaskContinuationAvailability(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string;
  readonly parentStepIndex: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<RuntimeSubagentDispatchFailure | undefined> {
  const active = await findActiveTaskForAgent(
    input.session,
    input.agentId,
    input.parentTurnId,
    input.parentStepIndex,
  );
  return active === undefined
    ? undefined
    : createTaskContinuationBusyResult({
        action: input.action,
        agentId: input.agentId,
        status: active.view.status,
        taskId: active.view.taskId,
      });
}

export function createTaskContinuationBusyResult(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string;
  readonly status: string;
  readonly taskId: string;
}): RuntimeSubagentDispatchFailure {
  return createAgentErrorResult({
    action: input.action,
    code: AGENT_BUSY,
    message: `Agent "${input.agentId}" is busy with task "${input.taskId}" (${input.status}).`,
  });
}

/**
 * Persists the task's ownership and routing entry in the parent session's
 * `eve.tasks` index and creates its parked tool-call receipt before dispatch.
 */
export async function persistContinuationTaskInParentSession(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string;
  readonly delegated: DelegatedTask;
  readonly session: RuntimeSession;
}): Promise<PersistedContinuationTask | undefined> {
  const handle = findTaskAgentAddress(input.session, input.agentId);
  if (handle === undefined) return undefined;
  return settleDelegatedDispatch({
    callId: input.action.callId,
    session: input.session,
    subagentName: handle.identity.name,
    task: input.delegated,
  });
}

export async function settleTaskDispatchError(input: {
  readonly delegated: DelegatedTask;
  readonly outcome: Extract<DispatchOutcome, { readonly kind: "error" }>;
  readonly persisted: PersistedContinuationTask | undefined;
}): Promise<RuntimeSubagentDispatchFailure> {
  const ambiguous = input.persisted !== undefined && input.outcome.deliveryAmbiguous === true;
  if (!ambiguous) {
    const settle = input.persisted === undefined ? rejectDelegatedDispatch : failDelegatedDispatch;
    await settle({ error: input.outcome.result.output, task: input.delegated });
  }
  return input.persisted === undefined
    ? input.outcome.result
    : {
        ...input.outcome.result,
        output: attachTaskId(input.outcome.result.output, input.delegated.taskId),
      };
}

function attachTaskId(output: JsonValue, taskId: string): JsonValue {
  return output !== null && typeof output === "object" && !Array.isArray(output)
    ? { ...output, taskId }
    : { error: output, taskId };
}
