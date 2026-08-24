import { ContextContainer } from "#context/container.js";
import {
  PendingToolOutputSpillsKey,
  SandboxKey,
  TurnTaskDeliveryKey,
  TurnTaskStateKey,
} from "#context/keys.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { AgentToolOutputDefinition } from "#shared/agent-definition.js";
import {
  projectOversizedToolOutputValue,
  type ToolOutputSpill,
} from "#harness/tool-output-overflow.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import { getSessionTaskIndex, type SessionTaskIndexEntry } from "#tasks/session-index.js";

export const TASK_DELIVERY_CONTEXT_LABEL = "[Task state]";

export const TASK_DELIVERY_INITIATING_INSTRUCTION = `Background task reporting: launch acknowledgement
The accompanying ${TASK_DELIVERY_CONTEXT_LABEL} system message is runtime-authored and lists background tasks accepted so far from the current turn. They continue independently after this turn.

Continue carrying out the user's request, including starting any remaining background work. When no further tool calls are needed in this turn, send one brief user-facing acknowledgement that the background work has started. Do not wait for results or report results that are not available yet. End the turn after the acknowledgement.`;

export const TASK_DELIVERY_PENDING_INSTRUCTION = `Background task control: incomplete cohort
This framework-authored instruction overrides any earlier instruction to report, summarize, acknowledge, or otherwise handle background results.

The accompanying ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists tasks started by the same parent turn. At least one of those tasks is still pending, so the combined report is not ready.

Action:
- You may call tools only if the newly delivered task result requires immediate action.
- Otherwise, take no action.

Delivery:
- Do not report completed tasks or partial results.
- Do not provide progress, status, an acknowledgement, or a waiting message.
- After any necessary tool calls, your entire final text response must be exactly ${EMPTY_DELIVERY_SENTINEL} and no other text.

Incorrect: "Two of three tasks have completed."
Incorrect: "Still waiting for the remaining task."
Correct: ${EMPTY_DELIVERY_SENTINEL}`;

export const TASK_DELIVERY_SETTLED_INSTRUCTION = `Background task reporting\nThis turn was triggered by background task activity. The accompanying ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists tasks started by the same parent turn, all settled, with every available terminal output. Do not reply with ${EMPTY_DELIVERY_SENTINEL}. Send one user-facing response that combines their useful results.`;

export async function prepareTaskDeliveryModelContext(input: {
  readonly ctx: ContextContainer;
  readonly policy?: AgentToolOutputDefinition;
  readonly resolved: StepInput | undefined;
  readonly state: SessionStateMap | undefined;
  readonly taskDeliveryId: string | undefined;
  readonly tasksEnabled: boolean;
  readonly turnId: string;
}): Promise<StepInput | undefined> {
  let resolved = input.resolved;
  let spills: readonly ToolOutputSpill[] = [];
  if (resolved !== undefined && input.taskDeliveryId !== undefined) {
    const taskContext = await resolveTaskDeliveryContext({
      policy: input.policy,
      sandboxAccess: input.ctx.get(SandboxKey),
      state: input.state,
      taskDeliveryId: input.taskDeliveryId,
    });
    if (taskContext !== undefined) {
      input.ctx.set(TurnTaskDeliveryKey, taskContext.phase);
      resolved = { ...resolved, context: [...(resolved.context ?? []), taskContext.context] };
      spills = taskContext.spills;
    }
  }

  if (input.tasksEnabled && input.ctx.get(TurnTaskDeliveryKey) === "none") {
    const taskContext = await resolveInitiatingTaskContext({
      policy: input.policy,
      sandboxAccess: input.ctx.get(SandboxKey),
      state: input.state,
      turnId: input.turnId,
    });
    if (taskContext !== undefined) {
      input.ctx.set(TurnTaskDeliveryKey, taskContext.phase);
      input.ctx.set(TurnTaskStateKey, taskContext.context);
      spills = taskContext.spills;
    }
  }

  if (spills.length > 0) input.ctx.set(PendingToolOutputSpillsKey, spills);
  return resolved;
}

/** Returns model context and cohort phase for tasks started by the same parent turn as this delivery. */
export async function resolveTaskDeliveryContext(input: {
  readonly policy?: AgentToolOutputDefinition;
  readonly sandboxAccess?: SandboxAccess;
  readonly state: SessionStateMap | undefined;
  readonly taskDeliveryId: string;
}): Promise<
  | {
      readonly context: string;
      readonly phase: "pending" | "settled";
      readonly spills: readonly ToolOutputSpill[];
    }
  | undefined
> {
  const entries = getSessionTaskIndex(input.state);
  const delivered = entries.find((entry) => input.taskDeliveryId.startsWith(`${entry.taskId}:`));
  if (delivered === undefined) return undefined;

  const cohort = entries.filter((entry) => entry.createdByTurnId === delivered.createdByTurnId);
  return projectTaskCohort({
    cohort,
    policy: input.policy,
    sandboxAccess: input.sandboxAccess,
  });
}

/** Returns model context for durable tasks launched by the active parent turn. */
export async function resolveInitiatingTaskContext(input: {
  readonly policy?: AgentToolOutputDefinition;
  readonly sandboxAccess?: SandboxAccess;
  readonly state: SessionStateMap | undefined;
  readonly turnId: string;
}): Promise<
  | {
      readonly context: string;
      readonly phase: "initiating";
      readonly spills: readonly ToolOutputSpill[];
    }
  | undefined
> {
  const cohort = getSessionTaskIndex(input.state).filter(
    (entry) => entry.createdByTurnId === input.turnId,
  );
  if (!cohort.some((entry) => entry.executor !== undefined && entry.terminalView === undefined)) {
    return undefined;
  }
  return {
    ...(await projectTaskCohort({
      cohort,
      policy: input.policy,
      sandboxAccess: input.sandboxAccess,
    })),
    phase: "initiating",
  };
}

async function projectTaskCohort(input: {
  readonly cohort: readonly SessionTaskIndexEntry[];
  readonly policy: AgentToolOutputDefinition | undefined;
  readonly sandboxAccess: SandboxAccess | undefined;
}): Promise<{
  readonly context: string;
  readonly phase: "pending" | "settled";
  readonly spills: readonly ToolOutputSpill[];
}> {
  const settled = input.cohort.every((entry) => entry.terminalView !== undefined);
  const spills: ToolOutputSpill[] = [];
  const tasks = await Promise.all(
    input.cohort.map(async (entry) => {
      const lastOutput = settled ? entry.terminalView?.lastOutput : undefined;
      const output =
        lastOutput === undefined
          ? undefined
          : {
              ...lastOutput,
              data: await projectOversizedToolOutputValue({
                output: lastOutput.data,
                onSpill: (spill) => {
                  spills.push(spill);
                },
                policy: input.policy,
                sandboxAccess: input.sandboxAccess,
                taskId: entry.taskId,
              }),
            };
      return {
        name: entry.metadata.name,
        output,
        status: entry.terminalView?.status ?? "pending",
        taskId: entry.taskId,
      };
    }),
  );

  return {
    context: `${TASK_DELIVERY_CONTEXT_LABEL}\n${JSON.stringify({ tasks })}`,
    phase: settled ? "settled" : "pending",
    spills,
  };
}
