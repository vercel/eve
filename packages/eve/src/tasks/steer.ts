import type { ContextContainer } from "#context/container.js";
import { createLogger } from "#internal/logging.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import { AGENT_BUSY } from "#subagents/agent-handle-errors.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { steeringReceiptResult } from "#tasks/receipts.js";
import { renderAgentBusy } from "#tasks/render.js";
import { steerTask, withdrawSteer, type TaskTable } from "#tasks/table.js";
import { runCommands, sendAgentMessage, type CommandEffect } from "#tasks/transport.js";

const log = createLogger("tasks.steer");

/**
 * Sends a call's message to a working agent. The message joins the agent's
 * current generation: no generation starts, and the generation's one result
 * still reaches its caller. The call returns the steering receipt at once.
 * An agent that has not started yet gets the message when it reports
 * `task.started`. The message never changes the generation's output schema.
 *
 * The owner already rejected a call from a principal other than the one
 * the agent works for. A workflow body awaits the output of the generation
 * it started, so neither a `ctx.agent` call nor a model call may join a
 * generation the other started.
 *
 * An agent, local or remote, that answered before the message reached it
 * runs the message as its next turn for the same call. Its answer reports
 * how many messages it received, so the owner records that turn as the
 * agent's next detached generation, whose result arrives as a
 * `task.result`.
 */
export async function steerWorkingAgent(input: {
  readonly callbackAlias: string | undefined;
  readonly callId: string;
  readonly ctx: ContextContainer;
  /** The call comes from a workflow body (`ctx.agent`). */
  readonly fromWorkflow: boolean;
  readonly message: string;
  readonly ownerSessionId: string;
  readonly record: TaskRecord;
  readonly table: TaskTable;
  readonly toolName: string;
  /** The owner turn of the steering call. */
  readonly turnId: string;
}): Promise<
  | { readonly kind: "rejected"; readonly output: JsonValue }
  | {
      readonly kind: "sent";
      readonly result: RuntimeToolResultActionResult;
      readonly table: TaskTable;
    }
> {
  const { callId, record, toolName } = input;
  const busy = (reason: Parameters<typeof renderAgentBusy>[1]) => ({
    kind: "rejected" as const,
    output: { code: AGENT_BUSY, message: renderAgentBusy(record.id, reason) },
  });
  if (input.fromWorkflow) return busy("workflow-caller");
  if (record.workflowCaller !== undefined) return busy("workflow-owned");
  const command = {
    // The steering call's identity: a retried step resends the same key, and
    // the agent admits it once.
    key: `${input.turnId}:${callId}`,
    kind: "message" as const,
    message: input.message,
  };
  const transition = steerTask(input.table, record.id, command);
  for (const effect of transition.effects) {
    if (effect.kind !== "send") continue;
    const failure = await sendAgentMessage({
      callbackAlias: input.callbackAlias,
      command,
      ctx: input.ctx,
      ownerSessionId: input.ownerSessionId,
      record: effect.record,
    });
    if (failure !== undefined) return { kind: "rejected", output: failure };
  }
  return {
    kind: "sent",
    result: steeringReceiptResult({ callId, record, toolName }),
    table: transition.table,
  };
}

/**
 * Runs the commands held for a child that just reported `task.started`. A
 * held message that cannot be delivered then is dropped and logged, and is no
 * longer counted, so its generation's result arrives without it; the call
 * that sent it already returned its receipt. A stopped task's held messages
 * are not sent.
 */
export async function flushHeldCommands(input: {
  readonly callbackAlias: string | undefined;
  readonly ctx: ContextContainer | undefined;
  readonly effects: readonly CommandEffect[];
  readonly ownerSessionId: string;
  readonly table: TaskTable;
}): Promise<TaskTable> {
  let table = input.table;
  const others: CommandEffect[] = [];
  for (const effect of input.effects) {
    const rest = effect.commands.filter((command) => command.kind !== "message");
    if (rest.length > 0) others.push({ ...effect, commands: rest });
    if (isTerminalTaskStatus(effect.record.status)) continue;
    for (const command of effect.commands) {
      if (command.kind !== "message") continue;
      const failure = await sendAgentMessage({
        callbackAlias: input.callbackAlias,
        command,
        ctx: input.ctx,
        ownerSessionId: input.ownerSessionId,
        record: effect.record,
      });
      if (failure === undefined) continue;
      log.error("a held steering message did not reach its agent; its result will not reflect it", {
        taskId: effect.record.id,
      });
      table = withdrawSteer(table, effect.record.id, effect.record.generation);
    }
  }
  await runCommands(others, input.ctx);
  return table;
}
