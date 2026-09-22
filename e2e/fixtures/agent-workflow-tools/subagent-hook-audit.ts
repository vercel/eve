import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";

export interface SubagentHookObservation {
  readonly subscriber: "typed" | "wildcard";
  readonly type: "subagent.called" | "subagent.completed";
  readonly callId: string;
  readonly sessionId: string;
  readonly output?: string;
}

export const subagentHookAudit = defineState<SubagentHookObservation[]>(
  "workflow-fixture.subagent-hook-audit",
  () => [],
);

export function recordSubagentHook(
  subscriber: SubagentHookObservation["subscriber"],
  event: HookEvent,
  ctx: HookContext,
): void {
  if (event.type !== "subagent.called" && event.type !== "subagent.completed") return;
  if (event.type === "subagent.called" && ctx.session.id !== event.data.sessionId) {
    throw new Error("Subagent hook received a different parent session.");
  }
  subagentHookAudit.update((observations) => [
    ...observations,
    {
      subscriber,
      type: event.type,
      callId: event.data.callId,
      sessionId: ctx.session.id,
      output: event.type === "subagent.completed" ? event.data.output : undefined,
    },
  ]);
}
