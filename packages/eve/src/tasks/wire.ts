import type { TaskCommand, TaskRunInboundPayload, TaskUsage } from "#tasks/types.js";
import { readTaskUsage, taskAuthorizationRequestId } from "#tasks/types.js";

/**
 * Translates one inbound hook payload into a lifecycle command.
 *
 * The child wire is unchanged by `experimental.tasks`; delegated
 * dispatch hands children the task run's hook token, so the payloads
 * that used to resume the parent turn arrive here instead:
 *
 * - a settled child turn (local notification or remote callback)
 *   carries an explicit outcome — its result status decides
 *   `complete`, `fail`, or `cancel`;
 * - a forwarded HITL batch marks the task `input_required` with the
 *   outstanding requests;
 * - `authorization.required` also blocks the task (the child cannot
 *   proceed without the parent's user) under a reserved request id, and
 *   `authorization.completed` clears exactly that id. Authorization
 *   payloads never enter the view — only the fact that the child is
 *   blocked does.
 *
 * `input-response` is deliberately absent: the run must forward the
 * answers to the child before it may record them, so it builds that
 * command itself rather than translating one here.
 *
 * Returns `undefined` for unrecognized payloads, which the run ignores.
 */
export function translateTaskInboundPayload(
  payload: TaskRunInboundPayload,
): TaskCommand | undefined {
  switch (payload.kind) {
    case "task-command":
      return payload.command;
    case "runtime-action-result": {
      const result = payload.results[0];
      if (result === undefined) return undefined;
      if (result.outcome !== undefined) {
        // Usage retention: the settled outcome's `usageDelta` survives into
        // the terminal command so the view keeps the child's spend.
        const usage = readTaskUsage(result.outcome.usageDelta);
        switch (result.outcome.result.kind) {
          case "succeeded":
            return withUsage(
              { data: result.output, kind: "complete", lifecycle: result.outcome.kind },
              usage,
            );
          case "failed":
            return withUsage(
              { data: result.output, kind: "fail", lifecycle: result.outcome.kind },
              usage,
            );
          case "cancelled":
            return withUsage({ kind: "cancel", lifecycle: result.outcome.kind }, usage);
        }
      }
      return undefined;
    }
    case "subagent-input-request":
      return { inputRequests: payload.event.requests, kind: "require-input" };
    case "turn-started":
      return {
        childSessionId: payload.childSessionId,
        childTurnId: payload.childTurnId,
        kind: "start-turn",
        taskId: payload.taskId,
      };
    case "authorization-event": {
      const requestId = taskAuthorizationRequestId(payload.event);
      return payload.event.type === "authorization.required"
        ? { kind: "require-authorization", requestId }
        : { kind: "answered", requestIds: [requestId] };
    }
    default:
      return undefined;
  }
}

function withUsage(
  command: Extract<TaskCommand, { kind: "complete" | "fail" | "cancel" }>,
  usage: TaskUsage | undefined,
): TaskCommand {
  if (usage === undefined) return command;
  return { ...command, usage };
}
