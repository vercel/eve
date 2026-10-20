import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";

export type SubagentHookType = "task.started" | "task.ended" | "call.settled" | "child.opened";

export interface SubagentHookObservation {
  readonly subscriber: "typed" | "wildcard";
  readonly type: SubagentHookType;
  /** The call that started the task, or that owns the child session. */
  readonly callId: string;
  /** The event's position, as `line:index`. */
  readonly position: string;
  readonly sessionId: string;
  readonly taskId?: string;
  /** What a task's call settled with. */
  readonly output?: string;
  /** The session a `child.opened` event announced. */
  readonly childSessionId?: string;
}

export const subagentHookAudit = defineState<SubagentHookObservation[]>(
  "workflow-fixture.subagent-hook-audit",
  () => [],
);

/** The call that started `taskId`, from the `task.started` this subscriber already recorded. */
function callOfTask(subscriber: string, taskId: string): string | undefined {
  return subagentHookAudit
    .get()
    .find(
      (record) =>
        record.subscriber === subscriber &&
        record.type === "task.started" &&
        record.taskId === taskId,
    )?.callId;
}

function isTaskCall(subscriber: string, callId: string): boolean {
  return subagentHookAudit
    .get()
    .some(
      (record) =>
        record.subscriber === subscriber &&
        record.type === "task.started" &&
        record.callId === callId,
    );
}

function observe(
  subscriber: SubagentHookObservation["subscriber"],
  event: HookEvent,
): Omit<SubagentHookObservation, "position" | "sessionId" | "subscriber"> | undefined {
  switch (event.type) {
    case "task.started":
      return {
        type: event.type,
        callId: event.data.startedBy.callId,
        taskId: event.data.taskId,
      };
    case "task.ended": {
      const callId = callOfTask(subscriber, event.data.taskId);
      return callId === undefined
        ? undefined
        : { type: event.type, callId, taskId: event.data.taskId };
    }
    case "call.settled":
      if (!isTaskCall(subscriber, event.data.callId)) return undefined;
      return {
        type: event.type,
        callId: event.data.callId,
        output: typeof event.data.output === "string" ? event.data.output : undefined,
      };
    case "child.opened": {
      const { owner } = event.data;
      const callId = "callId" in owner ? owner.callId : callOfTask(subscriber, owner.taskId);
      return callId === undefined
        ? undefined
        : { type: event.type, callId, childSessionId: event.data.sessionId };
    }
    default:
      return undefined;
  }
}

export async function recordSubagentHook(
  subscriber: SubagentHookObservation["subscriber"],
  event: HookEvent,
  ctx: HookContext,
): Promise<void> {
  const observation = observe(subscriber, event);
  if (observation === undefined) return;
  const position = `${ctx.position.line}:${ctx.position.index}`;
  const sandbox = await ctx.getSandbox();
  await sandbox.writeTextFile({
    path: `subagent-hook-${position.replace(":", "-")}-${subscriber}.txt`,
    content: observation.callId,
  });
  subagentHookAudit.update((observations) => [
    ...observations,
    { ...observation, position, sessionId: ctx.session.id, subscriber },
  ]);
  if (subscriber === "typed") {
    throw new Error("Fixture subagent observer failed after recording its event.");
  }
}
