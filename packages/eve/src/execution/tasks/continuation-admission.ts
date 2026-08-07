import {
  createAgentErrorResult,
  type DispatchOutcome,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import { findActiveTaskForAgent, findTaskAgentAddress } from "#execution/tasks/control-shared.js";
import {
  failDelegatedDispatch,
  settleDelegatedDispatch,
  type DelegatedTask,
} from "#execution/tasks/delegate.js";
import { describeTaskAgent } from "#execution/tasks/agent-identity.js";
import { AGENT_BUSY, AGENT_UNREACHABLE } from "#harness/agent-handle-errors.js";
import type { RuntimeSubagentDispatchFailure } from "#runtime/actions/types.js";
import type { JsonValue } from "#shared/json.js";

export type ReservedTaskContinuation = Awaited<ReturnType<typeof settleDelegatedDispatch>>;

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

export async function checkTaskContinuationAdmission(input: {
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
    : createAgentErrorResult({
        action: input.action,
        code: AGENT_BUSY,
        message: `Agent "${input.agentId}" is busy with task "${active.view.taskId}" (${active.view.status}).`,
      });
}

export async function reserveTaskContinuation(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string;
  readonly delegated: DelegatedTask | undefined;
  readonly session: RuntimeSession;
}): Promise<ReservedTaskContinuation | undefined> {
  if (input.delegated === undefined) return undefined;
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
  readonly agentId: string | undefined;
  readonly delegated: DelegatedTask | undefined;
  readonly outcome: Extract<DispatchOutcome, { readonly kind: "error" }>;
  readonly reserved: ReservedTaskContinuation | undefined;
  readonly session: RuntimeSession;
}): Promise<RuntimeSubagentDispatchFailure> {
  const retainedAddress =
    input.agentId !== undefined && findTaskAgentAddress(input.session, input.agentId) !== undefined;
  const ambiguous =
    input.reserved !== undefined &&
    readErrorCode(input.outcome.result.output) === AGENT_UNREACHABLE &&
    retainedAddress;
  if (input.delegated !== undefined && !ambiguous) {
    await failDelegatedDispatch({ error: input.outcome.result.output, task: input.delegated });
  }
  return input.reserved === undefined
    ? input.outcome.result
    : {
        ...input.outcome.result,
        output: attachTaskId(input.outcome.result.output, input.delegated?.taskId),
      };
}

function attachTaskId(output: JsonValue, taskId: string | undefined): JsonValue {
  if (taskId === undefined) return output;
  return output !== null && typeof output === "object" && !Array.isArray(output)
    ? { ...output, taskId }
    : { error: output, taskId };
}

function readErrorCode(output: JsonValue): string | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const code = Reflect.get(output, "code");
  return typeof code === "string" ? code : undefined;
}
