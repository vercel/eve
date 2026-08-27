import {
  createAgentErrorResult,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import {
  findActiveTaskForAgent,
  findTaskAgentAddress,
} from "#execution/tasks/parent/control-shared.js";
import { describeTaskAgent } from "#execution/tasks/parent/agent-identity.js";
import { AGENT_BUSY } from "#harness/agent-handle-errors.js";
import type { RuntimeSubagentDispatchFailure } from "#shared/action-types.js";

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
