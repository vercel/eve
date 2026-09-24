import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";

export interface SubagentHookObservation {
  readonly subscriber: "typed" | "wildcard";
  readonly type: "task.started" | "task.settled";
  readonly callId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly output?: string;
}

export const subagentHookAudit = defineState<SubagentHookObservation[]>(
  "workflow-fixture.subagent-hook-audit",
  () => [],
);

export async function recordSubagentHook(
  subscriber: SubagentHookObservation["subscriber"],
  event: HookEvent,
  ctx: HookContext,
): Promise<void> {
  if (event.type !== "task.started" && event.type !== "task.settled") return;
  // Workflow tool calls are tasks too; this audit follows agent delegation only.
  if (event.type === "task.started" && event.data.kind !== "agent") return;
  if (
    event.type === "task.settled" &&
    !subagentHookAudit
      .get()
      .some((record) => record.type === "task.started" && record.callId === event.data.callId)
  )
    return;
  const sandbox = await ctx.getSandbox();
  await sandbox.writeTextFile({
    path: `subagent-hook-${event.meta.id}-${subscriber}.txt`,
    content: event.data.callId,
  });
  subagentHookAudit.update((observations) => [
    ...observations,
    {
      subscriber,
      type: event.type,
      callId: event.data.callId,
      eventId: event.meta.id,
      sessionId: ctx.session.id,
      output:
        event.type === "task.settled" && typeof event.data.output === "string"
          ? event.data.output
          : undefined,
    },
  ]);
}
